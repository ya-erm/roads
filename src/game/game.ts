import {
  ANNEX,
  CAR_COLORS,
  CONSTRUCTION,
  COST,
  ECONOMY,
  GRADE,
  IDM,
  LEGACY_START_YEAR,
  MIN_SEGMENT_LEN,
  MONTH_LENGTH,
  MONTH_SCALE,
  RAIL_STATION,
  SIM_DT,
  START_YEAR,
  STATION,
  STOP,
  STORAGE,
  TERM_SCALE,
  TOWN_GROWTH,
  TOWN_TRAFFIC,
} from '../config';
import { Cubic, CurveLUT, intersectCurves, straightCubic } from '../core/bezier';
import { money as usd } from '../core/moneyText';
import { Rng } from '../core/rng';
import { durationText } from '../core/timeText';
import { add, angleDiff, angleOf, cross, dist, dot, rightNormal, scale, sub, Vec } from '../core/vec';
import { Anchor, anchorAt, buildRing, buildRoad, bulldoze, insideRuns, splitCorridor } from '../lanes/edit';
import { edgesAt, nodeCuts } from '../lanes/geometry';
import { copyBox, Fragment, pasteFragment } from '../lanes/fragment';
import { autoMainPair, mainPairOf } from '../lanes/graph';
import { PhaseSpec, phaseTurnStates, specOf, turnClashes, type TurnState } from '../lanes/lights';
import { besideOffset, Corridor, type CorridorBuild, laneKey, LaneLink, LaneNet, LaneNetSave, LaneNode, oneWay, parseLaneKey, taperLen, twoWay } from '../lanes/model';
import { gradeFactor } from '../lanes/speedProfile';
import type { LaneTraffic } from '../lanes/traffic';
import { Leaving, RailSim, Train } from '../sim/rail';
import { stepWagons } from '../sim/wagons';
import type { Vehicle, VehicleLook, VehicleSpec } from '../sim/vehicle';
import { hitchOf, steerBase } from '../sim/body';
import { bridgeLook, deckAlong } from '../lanes/deck';
import { CARGO, CargoType, FREIGHT, INDUSTRY_TYPES, IndustryKind, isTankCargo } from '../world/cargo';
import { Annex, type BuildBase, type Deposit, Industry, Station, StationServes, Structure, Town, TOWN_HISTORY, TownBuilding, type TownPark, TownSupplyMonth, Warehouse } from '../world/entities';
import { closeSupply, lastTownNeed, monthTownNeed, townNeed } from '../world/townSupply';
import { addTownPax, closeTownPax, PAX_NOWHERE, PAX_PER_THOUSAND } from '../world/townPax';
import { repaceSave, saveMonthLength } from './monthPace';
import { PAX_WAIT, paxLeaving, paxPatience, paxStayShare, paxTolerance } from './paxPatience';
import { Network, NetworkSave, Segment } from '../world/network';
import { halfWidth, isDirt, isRail, isTrunk, KMH_PER_UNIT, LANE_W, RAIL_HALF, RAIL_SPEC, ROAD_MARGIN, specCost, TRACK_GAP, WALK_EDGE } from '../world/roadTypes';
import { Footprint, footprintCorners, footprintRadius, FootprintIndex, footprintsOverlap, pointInFootprint } from '../world/spatial';
import { DEFAULT_SETTINGS, parkingOn, retailOn, WorldSettings } from '../world/settings';
import { Terrain, TerraformEdit, TerraformMode } from '../world/terrain';
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
  parkSite,
  placeable,
  railNear,
  rearByGap,
  recountPopulation,
  streetFace,
  WorldContext,
} from '../world/worldgen';
import { carryFootprint, hallPlaza, movablePark, nearPark, parkMoveCost, placeParks, plazaAttached, plazaBy } from '../world/townParks';
import { lotClearOfRoads, lotGrid, lotOutline } from '../world/lotClear';
import { streetBase, turnableBuilding, turnReach, wrapTurn } from '../world/moveTurn';
import { type ParkEntry, ParkIndex } from '../world/parkPick';
import { edgeOf, FORM_NAMES, formOf, residentsOf, SETTLE_RULE, townTier, yardOf, zoneTown } from '../world/townForms';
import { START_ROADS } from '../world/startRoads';
import { alongBan, banCovered, STREET_BAN, uncoveredRuns } from '../world/streetBans';
import { EconomyMods, NO_MODS } from '../scenario/effects';
import { prepareSettings } from '../scenario/generator';
import { Ideas, type IdeasState } from '../scenario/ideas';
import { Scenario } from '../scenario/manager';
import { rescalePopulation } from '../scenario/objectives';
import type { Ref, ScenarioState } from '../scenario/types';
import { findCrossings, LevelCrossing } from './crossings';
import { Journal, JournalEntry } from './journal';
import { News, NOTICE_AFTER_PAUSE, NOTICE_LIFE, type NewsKind, type NewsRecipe, type NewsRef, type NewsSave } from './news';
import { serviceCall, serviceTick, SERVICE_TRAFFIC, SERVICES, type ServiceKind } from './services';
import { paxFare, ridePath } from './fare';
import { curbHeading, mergeStops, nearerHalf, rideAhead } from './stopPairs';
import { transferable, transferNeighbors } from './transfer';
import { corridorCost, curbFootprint, isStopStreet, RoadBuilder, RoadPlan, shortOfMoney, type ProjectStart } from './roadbuild';
import { Construction, type ConstructionSave, type Project, projectName } from './construction';
import { WorkSignals } from './workSignals';
import { Crosswalks, WALK_HOUSES, WALK_LOSS } from './crosswalks';
import { Garages, type GarageHost, type GarageLook } from './garages';
import { ShopParking, type ShopHost } from './shopParking';
import { Docks, type DockHost } from './docks';
import { type BodyLook, type CrewLoopHost, CrewLoops, LOOP } from './crewLoop';
import {
  acceptAt,
  legacyCargo,
  markDry,
  maxTruck,
  pickReceivers,
  RETAIL,
  type Receiver,
  receiverDry,
  receiverOf,
  receiverStocked,
  roomFor,
  stockCap,
  stockFill,
  unloadTime,
  zoneRetail,
} from '../world/retail';
import { CAR_SIZE, drivewayLink, drivewayOf, type Driveway, LOT_SETBACK, lotFrame } from '../world/houseAccess';
import { DEPOT_MIN_W, roofCenter } from '../world/shopLots';
import { yardLotOf, yardSpots } from '../world/yardLots';
import { CarHomes, type CarHomesHost } from './carHomes';
import { parkingCells, type ParkingCell } from './parkingLayer';
import { curbSqueeze, type Squeeze } from '../world/curbSqueeze';
import { CURB_TRIPS, CurbParking, type CurbHost } from './curbParking';
import { emptyStats, LotParking, type LotHost, type LotRef } from './lotParking';
import { ParkSearch } from './parkSearch';
import {
  defaultGates,
  gateIn,
  gateOut,
  LOT,
  lotAngle,
  lotCost,
  lotDepth,
  lotGateDriveway,
  lotGateNode,
  lotIsBig,
  lotLocal,
  lotRows,
  type LotRows,
  lotStallCount,
  lotUpkeep,
  lotWidth,
  snapGate,
} from '../world/parkingLots';
import type { LotGate, ParkingLot } from '../world/entities';
import { laneSlot } from './garages';
import { CURB, fitCurbNet } from '../lanes/curb';
import { CURB_GROW, frontage, withCurb } from '../world/curbStreets';
import { setWalk, syncWalks, WALK_BAN_TEXT, type WalkArm, walkArms, walkCost, type WalkGeo, walkGeo, XWALK } from '../lanes/crosswalk';
import { Enterprises, industryRecipe } from './enterprises';
import { isActive } from '../world/enterprise';
import { carryBuild, carryRailBuild, paidFor, spansOf } from './constructionWork';
import { revertRebuild } from './rebuild';
import type { Brigade } from './crews';
import { CREW_UNITS, laneTrail } from './crewLane';
import { type CrewStep, CrewRoads } from './crewRoads';
import { RING_SIZES, RingOptions, Roads } from './roads';
import { TimelapseRecorder, type TimelapseSave } from './timelapse';
import { Motion, SpeedChart, speedChart, TrackPiece } from './speedChart';
import { BuildContext, Builder, Plan, type RailProjectStart, RoadRequest, Snap } from './build';
import { diamondPlan, TemplateOptions, templatePlan, TemplatePlan } from './interchange';
import { cloneNetwork, copyRails, RailPaste } from './railFragment';
import { chainCoords, chainOffset, parallelLevelProblem, trackChain } from './railEdit';
import {
  extendGeom,
  type ExtraTrack,
  extraTrackGeom,
  healCuts,
  type PlatformExtend,
  stationShape,
  stripRailStation,
  type TrackSide,
} from './railStationEdit';
import { linesForTown } from './townLines';
import { Approach, Jam, jamShown, nextJam, queuedAt } from './stationJam';
import { inWarehouseZone, storageSlots, warehouseFootprint } from './warehouses';
import { annexFootprint, annexReady, growthCap, inAnnexZone } from './annexes';
import { type AutoFunds, autoFunds } from './autoFunds';
import { RENEW_GAP, type RenewCar, renewStep } from './autoRenew';
import { firstRunWaits } from './firstRun';
import { familyOf, legacyCarried, ModelUnlocks, type UnlocksSave } from './unlocks';
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
  modelName,
  MODELS,
  modelsFor,
  ModelTier,
  newestLike,
  renewOn,
  RailModel,
  StopRule,
  vehicleCapacity,
  vehicleLoad,
  carsOf,
  handlingStreams,
  handlingTime,
  bayBox,
  bayFront,
  bayPose,
  entryPose,
  nearestBay,
  Pose,
  stopBerth,
} from './transport';

export type StationKind = Station['kind'];

export type TurnKind = 'left' | 'straight' | 'right';

/**
 * Темп списаний (Game.upkeepForecast), $ в месяц: по статьям и всего. Списывается непрерывно (Game.accrueUpkeep) —
 * за полный месяц при том же парке, бригадах, сети и долге уходит ровно столько.
 */
export interface UpkeepForecast {
  vehicles: number;
  crews: number;
  roads: number;
  interest: number;
  total: number;
}

/** Площадка-стоянка, которую ставят инструментом «🅿️ Площадка»: мест в ряду, рядов, поворот (Alt), ворота. */
export interface LotShape {
  cols: number;
  rows: LotRows;
  angle?: number;
  free?: boolean;
  gates?: readonly LotGate[];
}

/** Можно ли поставить площадку (Game.lotCheck): участок, ворота, мест, цена, снос, тупики-выезды большой. */
export interface LotPlan {
  ok: boolean;
  reason?: string;
  fp: Footprint;
  gates: LotGate[];
  stalls: number;
  /** Больше LOT.big мест: ворота — через узел (тупики-выезды в roads). */
  big: boolean;
  /** Сколько заплатим всего (минус — сколько вернём): площадка, снос, тупики. */
  cost: number;
  /** За саму площадку: сколько платим и сколько вернём (перенос, меньше). */
  spend: number;
  back: number;
  demolish: number[];
  roads?: RoadPlan;
  /** Где узлы ворот большой площадки. */
  nodes?: Vec[];
  town?: Town;
  /** Ворота, что не встали (нет улицы рядом, у перекрёстка), — красным. */
  badGates?: number[];
}

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
  /** Сигнал здесь уже есть, но другого типа — клик меняет тип. */
  retype?: boolean;
  /** Сигнал запрещает встречное движение. */
  oneWay?: boolean;
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
  /** Фазы светофора, что работают сейчас (у узла без светофора — пусто). */
  phases: JunctionPhase[];
  /** Фазы задал игрок; нет — «Авто» (встречные подъезды вместе). */
  phasesCustom: boolean;
  /** Повороты, по которым можно проехать (есть манёвры), — `${полотно въезда}>${полотно выезда}`. */
  liveTurns: string[];
  label: (seg: number) => Compass;
  /** Сколько полос въезда игрок настроил вручную. */
  customLanes: number;
}

/** Фаза светофора для карточки перекрёстка. */
export interface JunctionPhase {
  /** Повороты с зелёным: `${полотно въезда}>${полотно выезда}`. */
  go: string[];
  green: number;
  /** Сейчас зелёный этой фазы (или жёлтый после неё — clearing). */
  active: boolean;
  clearing: boolean;
  /** Повороты, которых игрок не дал ни в одну фазу, — своя фаза «Авто». */
  extra: boolean;
  /** Повороты, что едут, уступая встречным (налево на общий зелёный). */
  yields: string[];
  /** Повороты, что пересекаются с другими зелёными этой фазы, а уступать некому, — конфликт. */
  clashes: string[];
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
/** Перенесённый дом: от края асфальта до участка, м — как у домов улиц при застройке (worldgen.fillStreet: hw + 5), за тротуаром. */
const MOVE_SETBACK = 5;

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
  /** Места парков городов (перенос парка, площадь, что уехала с ратушей); нет в старых снимках. */
  parks?: { townId: number; list: Pick<TownPark, 'id' | 'fp' | 'moved' | 'turn'>[] }[];
  /** Пристройки предприятий и уровень, который они дали (нет в старых снимках). */
  industries?: { id: number; level?: number; streak?: number; annexes?: Annex[] }[];
  roundabouts: [number, Vec][];
  moneyBefore: number;
  /** Сколько правок рельефа было до действия. */
  terraform: number;
  /** Сколько стоило действие — вернётся при отмене. */
  spent: number;
  /** Проекты стройки до действия (нет в старых снимках) и какие проекты действие заложило. */
  projects?: Project[];
  creates?: number[];
  /** Места строительных баз до действия (перенос базы, база, отодвинутая расширением улицы); нет в старых снимках. */
  bases?: { id: number; fp: Footprint; nodeId: number }[];
  /** Снимок для повтора (Ctrl+Y): мазки кисти рельефа, что отмена убрала, — нанести снова. */
  terraformRedo?: TerraformEdit[];
  /** Снимок для повтора: дома, которые вернула отмена (действие их снесло), — снести снова. */
  dropBuildings?: { townId: number; ids: number[] }[];
  /** Запреты улиц городов до действия (снос их ставит, дорога игрока снимает): отмена возвращает как было. */
  streetBans?: { townId: number; list: Vec[][] }[];
  /** Площадки-стоянки городов до действия (без счёта за месяц); нет в старых снимках. */
  lots?: { townId: number; list: ParkingLot[] }[];
}

/** Площадки города без счёта за месяц — что сравнивать и что возвращать отменой. */
function lotsShape(list: readonly ParkingLot[] | undefined): ParkingLot[] {
  return (list ?? []).map(({ month: _m, last: _l, ...rest }) => structuredClone(rest));
}

/** База стоит там же (площадка и ворота), что и в снимке s. */
function sameBasePlace(b: BuildBase, s: { fp: Footprint; nodeId: number }): boolean {
  return b.nodeId === s.nodeId && b.fp.center.x === s.fp.center.x && b.fp.center.y === s.fp.center.y && b.fp.angle === s.fp.angle;
}

/** Участки совпадают: место, размер и поворот. */
function sameFootprint(a: Footprint, b: Footprint): boolean {
  return a.center.x === b.center.x && a.center.y === b.center.y && a.w === b.w && a.h === b.h && a.angle === b.angle;
}

/** По умолчанию станция работает и с пассажирами, и с грузом. */
export const ALL_SERVICES: StationServes = { pax: true, cargo: true };

/** Геометрия будущего вокзала: где резать путь и куда класть второй. */
interface RailStationGeom {
  segId: number;
  /** Проходная: стрелка, начало платформы, конец платформы, стрелка — вдоль пути. */
  cuts?: [number, number, number, number];
  /**
   * Конечная (тупиковая): точки на главном пути — горловина (стрелка), начало платформы и упор
   * (конец пути). Точками, а не длиной вдоль пути: путь в чистом поле строитель может положить в любую сторону.
   */
  terminal?: { throat: Vec; start: Vec; buffer: Vec };
  /** Дополнительные пути (2-й, 3-й, …): съезд, платформа и (у проходной) съезд обратно. */
  tracks: ([Cubic, Cubic] | [Cubic, Cubic, Cubic])[];
  /** Станция в чистом поле: сначала строим этот главный путь (segId тогда −1). */
  main?: RoadRequest;
}

/** Машина бригады стройки (crews.ts): самосвал в потоке. */
type SimOwner =
  | { type: 'fleet'; id: number }
  | { type: 'citizen'; trip?: CarTrip }
  | { type: 'crew'; id: number }
  | { type: 'service'; kind: ServiceKind; trip?: CarTrip };

/**
 * Поездка машины жителя или спецмашины: из какого здания и в какое (у каждого — свой город, TownBuilding.townId). Только
 * в памяти — для карточки машины (машины в сохранение не пишутся); после загрузки у машин её нет.
 */
export interface CarTrip {
  from: TownBuilding;
  to: TownBuilding;
}

/**
 * Машины колонны бригады (crews.ts, по порядку) — та же техника, что работает на стройке, тот же рисунок, длина и
 * ширина (crewLane.CREW_UNITS, vehicleArt.crewUnitArt): головная — грейдер с самосвалом грунта, за ней асфальтоукладчик
 * с катком, последней — машина разметки. Тяжёлая техника тихоходнее.
 */
const CREW_CARS = CREW_UNITS.map((u, k) => ({
  kind: 'truck' as const,
  body: u.body,
  length: u.length,
  width: u.width,
  maxSpeed: [24, 22, 28][k],
  accel: [3.5, 3, 4.5][k],
  color: '#f2b81d',
}));

/**
 * Бригада на ж/д стройке (проект пути, construction.ts) — те же машины в цвете путейцев: головная отсыпает балласт,
 * вторая кладёт шпалы, третья — рельсы (Game.crewCar).
 */
const RAIL_CREW_COLOR = '#e2622c';

/** Сколько секунд головная машина колонны ждёт у конца пути остальных (Game.crewAssembled), прежде чем сойти одной. */
const CREW_WAIT = 25;

/**
 * Машина бригады не в потоке — как её рисовать (Game.siteCrewLooks): вид машины, её этап (номер в колонне), участок,
 * если она на нём (там техника отсыпки моста и тоннеля — кран и щит).
 */
export type CrewLook = VehicleLook & { stage: number; site?: number };

export interface Notice {
  /** Номер уведомления — по нему его находят клик и крестик (порядок в списке меняется). */
  id: number;
  text: string;
  color?: string;
  /** Сколько уже показано, с (реальных; на паузе не растёт). */
  age: number;
  /** Номер записи в истории «События» (уведомление с видом) — клик по уведомлению отмечает её прочитанной. */
  news?: number;
  /** Куда ведёт клик по уведомлению: точка и радиус обзора (достроенная улица). */
  at?: { pos: Vec; r: number };
  /** О чём уведомление: клик открывает первое из них (предприятие, город, станция, маршрут…). */
  refs?: NewsRef[];
  /** Значки сырья и продукции перед названием предприятия в тексте. */
  recipe?: NewsRecipe;
}

/** Что ещё знает уведомление: вид (с ним оно попадает в историю «События»), о чём оно и где. */
export interface NoticeInfo {
  kind?: NewsKind;
  refs?: NewsRef[];
  at?: Notice['at'];
  recipe?: NewsRecipe;
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
  /** Награды и субсидии сценария (в старых сохранениях нет). */
  grants?: number;
  /** Штрафы сценария. */
  fines?: number;
}

export const emptyLedger = (): Ledger => ({ transport: 0, sales: 0, vehicles: 0, roads: 0, build: 0, purchases: 0, interest: 0, grants: 0, fines: 0 });

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
  /** Получатель в городе (world/retail.ts) — дом магазина: pos — у него, а не в центре города. */
  b?: number;
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
  /** Время партии, секунд игры. */
  time: number;
  /**
   * Улицы, которые город застроил до отказа: [id полотна, месяц, когда выяснилось] (Game.fullStreets). Без них после
   * загрузки город пробовал бы застроить их снова и рос бы иначе, чем в той же партии без сохранения. Нет — старое
   * сохранение: пробует все.
   */
  fullStreets?: [number, number][];
  /**
   * Длина месяца партии, секунд (MONTH_LENGTH на момент сохранения). Нет — старое сохранение: 120 с (или 40 с);
   * при загрузке партия пересчитывается под нынешний месяц с той же датой (monthPace.ts).
   */
  monthLength?: number;
  /**
   * Старая партия с месяцем длиннее нынешнего прожила больше реального времени, чем показывает календарь: на
   * столько месяцев нынешнего темпа модели транспорта выходят раньше по календарю (Game.modelYear). Нет — 0.
   */
  paceShift?: number;
  /** Год начала партии; month считается от него. В старых сохранениях нет — LEGACY_START_YEAR. */
  startYear?: number;
  month: number;
  money: number;
  incomeMonth: number;
  expensesMonth: number;
  ledger?: Ledger;
  loan?: number;
  /**
   * Непрерывное содержание (Game.accrueUpkeep): до какого времени начислено (at) и начисленное, но ещё не списанное
   * ($ с дробью) у бригад, ремонта и процентов; у машин — FleetVehicle.upkeepDue. Нет — старое сохранение, где всё
   * списывалось в конце месяца одной суммой: начисление идёт с начала месяца — за прошедшую часть месяца спишется
   * в первую же секунду после загрузки, столько же, сколько списали бы итоги месяца.
   */
  upkeep?: { at: number; crews: number; roads: number; interest: number };
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
  /** Состояние сценария; нет — песочница. */
  scenario?: ScenarioState;
  /** Задания без сроков в песочнице и после сценария (scenario/ideas.ts); нет — ещё не включались. */
  ideas?: IdeasState;
  /**
   * Открытие моделей по объёму перевозок (unlocks.ts): перевезённое по семействам и открытые модели II и III. Нет —
   * сохранение до этого: открытое по прежним правилам (год, ступень) остаётся открытым, счёт — по журналу и доходу
   * нынешних линий (legacyCarried).
   */
  unlocks?: UnlocksSave;
  /** Прежняя ступень моделей сценария — только в старых сохранениях (до unlocks); нет — по этапу сценария. */
  modelTier?: ModelTier;
  /** Журнал партии (в старых сохранениях нет). */
  journal?: JournalEntry[];
  /** История уведомлений (окно «События»); в старых сохранениях нет. */
  news?: NewsSave;
  /** Кадры таймлапса партии (в старых сохранениях нет — запись пойдёт с загрузки). */
  timelapse?: TimelapseSave;
  /** Правки рельефа игроком (рельеф строится по seed заново, правки — поверх). В старых сохранениях нет. */
  terraform?: TerraformEdit[];
  /** Поезда в пути и на платформах. */
  rail?: ReturnType<RailSim['serialize']>;
  /** Проекты стройки (режим «Со строительством»); готовое — в полотнах сети дорог. Нет — проектов нет. */
  construction?: ConstructionSave;
  /** Месторождения (режим «Строит игрок», enterprises.ts). Нет — старая партия: месторождений нет. */
  deposits?: Deposit[];
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
  /** Станция вдоль дороги: узел — стык на улице, вдоль края — карман (Station.side). */
  side?: boolean;
  /**
   * Автовокзал у края улицы (Station.curb): сколько мест у перрона, с кармашком ли (хватило улицы), а если без —
   * сколько улицы ему нужно было (need) и сколько есть (have), м между стоп-линиями перекрёстков.
   */
  curb?: { bays: number; pocket: boolean; need: number; have: number };
  /** Длина выезда, м от кромки дороги (у станции в конце выезда, не у грузового двора). */
  drivewayLen?: number;
  /** Остановка встанет парой к этой — напротив, на другой стороне той же улицы (Station.pair). */
  pair?: number;
}

/**
 * Как ставить автостанцию или автовокзал: длина выезда (м от кромки дороги), вдоль дороги с карманом-дублёром (side)
 * или у самого края улицы (curb, только автовокзал) — с curbBays местами у перрона.
 */
export interface RoadStationOptions {
  driveway?: number;
  side?: boolean;
  curb?: boolean;
  curbBays?: number;
}

/**
 * Сколько улицы между перекрёстками нужно автовокзалу у края улицы на bays мест (с кармашком или без), если поперечные
 * улицы — обычные 1+1: их стоп-линии — в полуширине улицы и запасе на скругление угла (~14,5 м) от узла.
 */
export function curbNeed(bays: number, pocket: boolean): number {
  return Math.ceil(2 * curbLayout(bays, taperLen('street'), pocket).half + 2 * (LANE_W + ROAD_MARGIN + 6));
}

/** Машина стоит у станции прямо на улице (остановка, автовокзал у края улицы), а не заезжает на пост. */
export const onRoadStop = (st: Pick<Station, 'kind' | 'curb'>) => st.kind === 'stop' || !!st.curb;

/** Мест у перрона автовокзала у края улицы — в границах (1…STATION.curb.maxBays). */
export function clampCurbBays(n: number): number {
  return Math.max(1, Math.min(STATION.curb.maxBays, Math.round(n)));
}

/**
 * Автовокзал у края улицы вдоль неё (м), отгон кармашка — taper: stand — длина мест (от узла станции до носа
 * переднего автобуса), half — сколько улицы занято в каждую сторону от их середины, zone — где кармашек на полную
 * ширину. С кармашком места — и на половинах отгонов (там полоса уже есть), без lead у начала и конца полосы.
 */
export function curbLayout(bays: number, taper: number, pocket: boolean): { stand: number; half: number; zone: number } {
  const C = STATION.curb;
  const S = clampCurbBays(bays) * C.berth;
  if (!pocket) return { stand: S, half: S / 2 + C.clear, zone: 0 };
  const zone = Math.max(4, S - taper + 2 * C.lead);
  return { stand: zone + taper - 2 * C.lead, half: zone / 2 + taper, zone };
}

/** Длина выезда — в допустимых границах и с шагом STATION.drivewayRange. */
export function clampDriveway(m: number): number {
  const R = STATION.drivewayRange;
  return Math.max(R.min, Math.min(R.max, R.min + Math.round((m - R.min) / R.step) * R.step));
}

/** Можно ли сделать на станции столько постов погрузки и во что это обойдётся. */
export interface BaysPlan {
  ok: boolean;
  reason?: string;
  /** Плюс — доплата за новые посты, минус — возврат за убранные. */
  cost: number;
  fp: Footprint | null;
}

/** Можно ли достроить ж/д вокзалу ещё один путь с платформой, где он ляжет и во что обойдётся. */
export interface RailTrackPlan extends BaysPlan {
  geom?: ExtraTrack;
  /** С какой стороны от путей ляжет новый: 1 — со стороны здания, -1 — с другой (там, где здание не мешает). */
  side?: TrackSide;
}

/** Удлинение платформ ж/д вокзала на шаг: сколько станет, куда (концы, стрелки) и почём. */
export interface RailExtendPlan extends BaysPlan {
  geom?: PlatformExtend;
  /** Длина платформ сейчас и после удлинения, м. */
  length: number;
  next: number;
}

/** Перенос ж/д станции: какой она станет на новом месте (конечной или проходной) и поворот в чистом поле. */
export interface RailMoveOptions {
  terminal?: boolean;
  angle?: number;
}

const MONTHS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
/** Выезд автостанции — шоссе 1+1, 90 км/ч (как «Шоссе» в панели дорог): машины со станции сразу едут быстро. */
const DRIVEWAY = { cls: 'highway' as const, lanes: twoWay(1, 1) };
/** Выезд грузового двора кончается на столько от стены предприятия; там же — тупик стартового просёлка. */
const INDUSTRY_EXIT = START_ROADS.industryExit;
/** Грузовой двор у стены предприятия — столько вглубь, м (industryStationPlan). */
const INDUSTRY_DOCK = 23;
/** Выезд станции из перекрёстка — не ближе этого угла (рад) к соседним дорогам. */
const STATION_JOIN_GAP = 0.5;

/**
 * Выезд-шоссе быстрее улиц, и «Авто» сделало бы главной дорогой перекрёстка его (с улицей напротив).
 * Главной остаётся та, что была бы без выезда: закрепляем её в узле примыкания. net — сеть с выездом
 * (план до стройки), nodePos — тупик выезда у станции. Главную, выбранную игроком, не трогаем.
 */
function keepMainRoad(net: LaneNet, nodePos: Vec): void {
  const station = net.nodesNear(nodePos, 2)[0];
  if (station?.corridors.length !== 1) return;
  const drive = net.corridor(station.corridors[0]);
  const join = net.node(drive.a === station.id ? drive.b : drive.a);
  if (join.mainPair != null) return;
  const ends = net.ends(join);
  if (!autoMainPair(ends)?.includes(drive.id)) return;
  const without = autoMainPair(ends.filter((e) => e.corridor.id !== drive.id));
  if (without) join.mainPair = without;
}

/**
 * Рост города (growTown): накопитель роста расходуется по жильцам новых домов — perPerson за жителя (или рабочее
 * место), но не меньше min за дом; unit — сколько накопить на дом, чтобы строить по несколько за раз. Прежде дом
 * стоил 20 при ~27 жителях в среднем — по доле город растёт так же.
 */
const GROW = { perPerson: 0.75, min: 2, unit: 20 };

/** Легковушка жителя: до ≈130 км/ч на автомагистрали; 7,5 × 3,6 (4,5 × 2,2 м) — world/houseAccess.CAR_SIZE. */
const CAR_SPEC = { kind: 'car' as const, length: CAR_SIZE.l, width: CAR_SIZE.w, maxSpeed: 60, accel: 10 };
/** Сквозной путь ж/д вокзала (первая платформа), если у него есть боковые пути; у конечной сквозного нет. */
const throughOf = (st: Station): number | undefined => (st.platforms.length > 1 && !st.terminal ? st.platforms[0] : undefined);
/** Платформы вокзала: боковые первыми, сквозной путь — последним (у конечной все тупики равны). */
const sidingsFirst = (st: Station): number[] => (st.platforms.length > 1 && !st.terminal ? [...st.platforms.slice(1), st.platforms[0]] : st.platforms);
/** Сколько путей с платформами у нового вокзала: от одного (остановочный пункт) до четырёх. */
export const clampRailTracks = (n: number): number =>
  Number.isFinite(n) ? Math.max(RAIL_STATION.minTracks, Math.min(RAIL_STATION.maxTracks, Math.round(n))) : 2;
/** Длина платформ нового вокзала, м: от minLength до maxLength шагом lengthStep. */
export const clampRailLength = (m: number): number => {
  const R = RAIL_STATION;
  if (!Number.isFinite(m)) return R.platform;
  return Math.max(R.minLength, Math.min(R.maxLength, Math.round(m / R.lengthStep) * R.lengthStep));
};
/**
 * Цена вокзала без путей: по цене станции за каждую платформу сверх первой (на один путь — как на два).
 * Половина цены — здание, половина растёт с длиной платформ: у обычной (150 м) — ровно цена станции.
 */
export const railStationFee = (tracks: number, length: number = RAIL_STATION.platform): number =>
  Math.round((RAIL_STATION.cost * Math.max(1, tracks - 1) * (0.5 + (0.5 * length) / RAIL_STATION.platform)) / 100) * 100;
/** Сколько вагонов длиной carLength встанет на платформу (поезду нужен запас 6 м). */
export const carsOnPlatform = (length: number, carLength: number): number => Math.max(0, Math.floor((length - 6) / carLength));
/**
 * Сколько пассажирских и сколько грузовых вагонов встанет на платформу — как предел состава в игре (maxCars):
 * у каждого рода — по самому длинному вагону среди его моделей.
 */
export function platformCars(length: number): { passenger: number; freight: number } {
  const longest = (kind: 'passenger' | 'freight') =>
    Math.max(...Object.values(MODELS).flatMap((m) => (m.mode === 'rail' && m.train.kind === kind ? [m.train.carLength] : [])));
  return { passenger: Math.max(2, carsOnPlatform(length, longest('passenger'))), freight: Math.max(2, carsOnPlatform(length, longest('freight'))) };
}

export class Game implements BuildContext {
  readonly rng: Rng;
  readonly terrain: Terrain;
  /** Железная дорога (пути, стрелки, сигналы, платформы). */
  readonly net = new Network();
  /** Дороги: сеть полос, граф движения и машины. */
  readonly roads: Roads;
  readonly index = new FootprintIndex<Structure>();
  /**
   * Раскладка застройки: растёт, когда дом или парк переносят (и когда отмена или повтор возвращает их): тротуары и
   * аллеи у улиц (renderer) — заново, хоть число домов и парков то же.
   */
  layoutRev = 0;
  /**
   * Номера правок нарисованного в плитках кэша карты (renderer.syncStill): растут при любой правке своего вида —
   * отрисовка сверяет подписи объектов, только когда номер сменился, а в покое не делает ничего. Предприятия: список,
   * место, уровень, пристройки, запасы, выпуск, стройка, руины, месторождения.
   */
  industryRev = 0;
  /** Застройка городов: дома, парки, черта города (номер правок — как industryRev). */
  townRev = 0;
  /** Станции: список, место, посты, узел, платформы, склады, пары остановок (номер правок — как industryRev). */
  stationRev = 0;
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
  private noticeSeq = 0;
  readonly floaters: Floater[] = [];
  readonly history: MonthRecord[] = [];

  money: number;
  time = 0;
  speed = 1;
  incomeMonth = 0;
  expensesMonth = 0;
  /** Статьи доходов и расходов текущего месяца. */
  ledger: Ledger = emptyLedger();
  /** Взятый кредит: проценты — от нынешнего долга, списываются непрерывно (accrueUpkeep). */
  loan = 0;
  citizenCars = 0;
  /** Спецмашин городов в потоке (services.ts). */
  serviceCars = 0;
  private month = 0;
  /** До какого времени начислено содержание (accrueUpkeep). */
  private upkeepAt = 0;
  /** Начислено, но ещё не списано, $ с дробью: бригады, ремонт, проценты (у машин — FleetVehicle.upkeepDue). */
  private upkeepDue = { crews: 0, roads: 0, interest: 0 };
  /** Когда последний раз предупреждали «Компания на грани банкротства!» (nearBankrupt). */
  private brinkAt = -Infinity;
  private accumulator = 0;
  private nextEntityId = 1;
  private readonly owners = new Map<number, SimOwner>();
  /** Машина колонны бригады стоит у конца пути и ждёт остальных (crewAssembled): с какого времени. */
  private readonly crewWaitSince = new Map<number, number>();
  /** Колонна собралась: машины, что стоят за головной в очереди, — снять с дороги после шага потока (gatherCrews). */
  private crewGather: number[] = [];
  private roadValue = { version: -1, value: 0 };
  /** Части roadValueTotal: пути целиком (по версии путей и рельефа) и полотна дорог по одному (по их форме). */
  private railValue = { version: -1, value: 0 };
  private readonly corridorValue = new Map<number, { key: string; cost: number }>();
  /** Когда транспорт подъехал к нынешней станции (игровое время) — для журнала: сколько простоял. */
  private readonly arrivedAt = new Map<number, number>();
  /** Когда транспорт уехал с прошлой станции и сколько простоял в пути — для журнала: время и скорость рейса. */
  private readonly departedAt = new Map<number, number>();
  private readonly stoodOnTrip = new Map<number, number>();
  /** Очереди у станций, где все посты заняты (id станции → очередь); пересчёт — раз в полсекунды. */
  private readonly jams = new Map<number, Jam>();
  private jamClock = 0;
  /** Советнику: с какого времени машина готова уехать со станции (погрузилась) и с какого ждёт свободный пост. */
  private readonly readyAt = new Map<number, number>();
  private readonly bayWaitSince = new Map<number, number>();
  /** Прикидка времени круга линии, пока его не измерили по рейсам: когда считали и сколько вышло. */
  private readonly lapGuess = new Map<number, { at: number; lap: number | null }>();
  /**
   * Терпение пассажиров (paxPatience.ts), не сохраняется: свободных мест в машине линии, когда она приходит
   * на станцию (скользящее среднее; ключ «линия:станция»), дробный остаток уходящих по направлениям
   * («станция:назначение») и сколько ушло к остановкам линии с её последнего отправления отсюда — для авто-парка.
   */
  private readonly paxSeats = new Map<string, number>();
  private readonly paxLeaveAcc = new Map<string, number>();
  private readonly paxGoneSince = new Map<string, number>();
  /** Вызывается в конце каждого игрового месяца, когда итоги подведены и месяц уже новый, — для автосохранения. */
  onMonthEnd: () => void = () => {};
  /**
   * Сколько миллисекунд кадра отдавать итогам месяца. Бесконечность — итоги целиком в том же такте (тесты, node);
   * в браузере (main.ts) — несколько миллисекунд: рост городов, пересборка графа движения и остальное идут
   * по кадрам, а такты партии ждут, пока итоги не подведены. Шаги и их порядок те же — те же и числа.
   */
  monthBudget = Infinity;
  /** Итоги месяца, которые ещё идут (closeMonth); null — не идут. */
  private closing: Generator<void, void, void> | null = null;
  /** Сейчас выполняется шаг итогов. */
  private closingStep = false;
  /** Сценарий партии; null — песочница. */
  scenario: Scenario | null = null;
  /** Задания без сроков («Идеи»): в песочнице и после конца сценария. */
  ideas: Ideas = new Ideas(this);
  /** Множители экономики от событий сценария; в песочнице все равны 1. */
  mods: EconomyMods = NO_MODS;
  /**
   * Модели II и III открываются по объёму перевозок своего семейства (unlocks.ts, MODEL_UNLOCK) — в сценарии
   * и в песочнице одинаково, без этапов и годов.
   */
  unlocks = new ModelUnlocks();
  /** Год начала партии: у новой — START_YEAR, у загруженной — из сохранения (в старых нет — LEGACY_START_YEAR). */
  readonly startYear: number;
  /**
   * На сколько месяцев модели выходили раньше по календарю — у старой партии с месяцем длиннее (SaveData.paceShift):
   * по нему старое сохранение узнаёт, что уже вышло по прежнему календарю (Game.modelYear).
   */
  readonly paceShift: number;

  readonly settings: WorldSettings;
  /** Журнал партии для разбора: действия, рейсы, сводки, задания и события. */
  readonly journal: Journal;
  /** История уведомлений за последние месяцы — окно «События» (см. news.ts). */
  readonly news: News;
  /** Таймлапс партии: кадр сети в конце каждого месяца (см. timelapse.ts). */
  readonly timelapse: TimelapseRecorder;
  /** Стройка дорог (режим «Со строительством», src/game/construction.ts): проекты и их ход. */
  readonly construction: Construction;
  /** Временные светофоры реверса на перестройке «с проездом» узких дорог (src/game/workSignals.ts). */
  readonly workSignals = new WorkSignals();
  /** Пешеходы на переходах перекрёстков (src/game/crosswalks.ts): жители вокруг — по охвату, как у станций. */
  readonly crosswalks = new Crosswalks((p, r) => this.peopleNear(p, r).pop);
  /** Гаражи частных домов (src/game/garages.ts): машины жителей выезжают из них и возвращаются в них. */
  private readonly gHost = this.garageHost();
  readonly garages = new Garages(this.gHost);
  /** Стоянки магазинов и рынков (src/game/shopParking.ts): машины горожан заезжают на свободное место и уезжают. */
  readonly shops = new ShopParking(this.shopHost(), this.garages);
  /** Дворы получателей грузов (src/game/docks.ts): грузовик заезжает к рампе магазина, выгружается и выезжает. */
  readonly docks = new Docks(this.dockHost());
  /**
   * Разворот техники бригад петлёй у дороги вместо разворота в тупике (src/game/crewLoop.ts): у станции в конце выезда,
   * в конце проекта-тупика.
   */
  readonly crewLoops = new CrewLoops(this.crewLoopHost());
  /**
   * Полосы стоянки вдоль бордюра (src/game/curbParking.ts, docs/PARKING.md, этап 2): места ночёвки и места у целей,
   * манёвры передом и задом у бордюра.
   */
  readonly curb = new CurbParking(this.curbHost());
  /** Номер правки площадок-стоянок: поставили, перенесли, ворота, снос, отмена, загрузка (LotParking — заново). */
  lotRev = 0;
  /** Площадки-стоянки (src/game/lotParking.ts, docs/PARKING.md, этап 3): кто где стоит, ворота, выезды. */
  readonly lots = new LotParking(this.lotHost());
  /**
   * Парк машин жителей (src/game/carHomes.ts): у каждой машины своё место ночёвки — гараж, площадка, двор, полоса
   * стоянки, бокс; поездки начинаются с него и кончаются на нём.
   */
  readonly carHomes = new CarHomes(this.carHomesHost(), this.garages, this.curb, this.lots);
  /** Поиск места у цели (src/game/parkSearch.ts): полосы, площадки, до трёх попыток, иначе домой. */
  readonly parkSearch = new ParkSearch(this.searchHost(), this.curb, this.lots, this.garages, this.carHomes);
  /** Предприятия строит игрок (режим «Строит игрок», src/game/enterprises.ts): месторождения, постройка, рабочие, вред. */
  readonly enterprises: Enterprises;

  constructor(setup: WorldSettings | number, saved?: SaveData) {
    // Сценарий решает архетип по seed ещё до генерации карты: от него зависят города и предприятия.
    this.settings = prepareSettings(typeof setup === 'number' ? { ...DEFAULT_SETTINGS, seed: setup } : setup);
    // Старая партия с другой длиной месяца — под нынешний месяц, с той же датой (monthPace.ts).
    const paceFrom = saved && saveMonthLength(saved);
    const save = saved && repaceSave(saved);
    this.startYear = save ? (save.startYear ?? LEGACY_START_YEAR) : START_YEAR;
    this.paceShift = save?.paceShift ?? 0;
    this.journal = new Journal(() => this.time / MONTH_LENGTH, save?.journal);
    this.news = new News(save?.news);
    this.timelapse = new TimelapseRecorder(save?.timelapse);
    this.rng = new Rng(this.settings.seed);
    this.terrain = new Terrain(this.rng, this.settings);
    this.money = this.settings.money;
    this.roads = new Roads({
      dwell: (v) => this.dwellAt(v),
      curbStop: (v) => this.curbStop(v),
      canArrive: (v) => this.canArrive(v),
      onArrive: (v) => this.onArrive(v),
      onLost: (v) => this.onLost(v),
    });
    this.rail = new RailSim(
      this.net,
      {
        onArrive: (t) => this.onTrainArrive(t),
        onLost: (t) => this.onTrainLost(t),
      },
      (p, dir) => this.terrain.gradeAlong(p, dir),
    );
    this.builder = new Builder(this);
    this.roadBuilder = new RoadBuilder(this);
    this.construction = new Construction(this);
    this.enterprises = new Enterprises(this);
    // Машины на изгибах и уклонах: профиль скорости полос берёт рельеф отсюда.
    this.roads.traffic.relief = { ground: () => this.ground(), version: () => this.terrain.version };
    if (save) {
      this.restore(save);
      if (paceFrom !== MONTH_LENGTH) {
        // Месячные задания называют условие месяца и «N месяцев подряд» — названия по пересчитанным условиям.
        this.scenario?.retitle();
        this.journal.add('pace', { from: paceFrom, to: MONTH_LENGTH });
      }
      return;
    }
    const world = generateWorld(this.worldContext(), this.settings);
    this.towns = world.towns;
    this.industries = world.industries;
    this.enterprises.load(world.deposits);
    this.net.rebuild();
    // Улицы городов — с переходами среди домов.
    this.syncCrosswalks();
    this.roads.changed();
    // АЗС и оптовые базы (новые партии с получателями) — до машин на стоянках: под них отдаются и магазины.
    for (const t of this.towns) this.zoneRetailTown(t);
    // Площадки-стоянки у рынка и ратуши (новые партии с парковками, без сноса и без ГСЧ): по одной на дом, пока встают.
    for (const t of this.towns) while (this.townLots(t));
    // На стоянках магазинов уже стоят машины (по хешу).
    this.shops.seed(this.towns);
    // Получатели грузов в городах (новые партии, world/retail.ts): склады наполовину полны.
    for (const t of this.towns) this.refreshReceivers(t);
    const s = this.settings;
    this.journal.add('game', {
      seed: s.seed,
      size: s.size,
      towns: this.towns.length,
      industries: this.industries.length,
      deposits: this.enterprises.deposits.length || undefined,
      water: s.water,
      money: this.money,
    });
    if (this.settings.scenario) this.attachScenario(Scenario.create(this));
    // Первый кадр таймлапса — мир до первой дороги игрока.
    this.timelapse.capture(this);
  }

  private attachScenario(sc: Scenario): void {
    this.scenario = sc;
    this.mods = sc.mods;
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
    // Итоги месяца на середине (идут по кадрам) — сначала до конца: иначе после загрузки они пошли бы заново.
    this.settleMonth();
    return {
      version: SAVE_VERSION,
      settings: this.settings,
      savedAt: Date.now(),
      rng: this.rng.seedState,
      time: this.time,
      monthLength: MONTH_LENGTH,
      paceShift: this.paceShift || undefined,
      startYear: this.startYear,
      month: this.month,
      money: this.money,
      incomeMonth: this.incomeMonth,
      expensesMonth: this.expensesMonth,
      ledger: this.ledger,
      loan: this.loan,
      upkeep: { at: this.upkeepAt, ...this.upkeepDue },
      nextEntityId: this.nextEntityId,
      extraForests: this.terrain.extraForests,
      net: this.net.serialize(),
      roads: this.roads.net.toJSON(),
      towns: this.towns,
      fullStreets: this.fullStreets.size ? [...this.fullStreets] : undefined,
      industries: this.industries.map(({ info, type: _t, ...rest }) => ({ ...rest, kind: info.kind })),
      stations: [...this.stations.values()].map((s) => this.stationToSave(s)),
      lines: [...this.lines.values()],
      folders: [...this.folders.values()],
      fleet: [...this.fleet.values()].map((v) => this.fleetToSave(v)),
      roundabouts: [...this.roundaboutCenters],
      history: this.history,
      rail: this.rail.serialize(),
      scenario: this.scenario?.toSave(),
      ideas: this.ideas.toSave(),
      unlocks: this.unlocks.toSave(),
      journal: this.journal.entries,
      news: this.news.toSave(),
      timelapse: this.timelapse.toSave(),
      terraform: this.terrain.edits.length ? this.terrain.edits : undefined,
      construction: this.construction.toSave(),
      deposits: this.enterprises.deposits.length ? this.enterprises.deposits : undefined,
    };
  }

  /** Машина компании для сохранения; в пути — с местом на дороге, чтобы после загрузки ехать дальше оттуда же. */
  private fleetToSave(v: FleetVehicle): SaveData['fleet'][number] {
    // В пути или на остановке (автобус стоит на дороге) — с местом на дороге.
    const sim = v.state === 'driving' || v.state === 'loading' ? this.fleetSim(v) : undefined;
    if (!sim) return v;
    const spot = this.traffic.spotOf(sim);
    return { ...v, onRoad: { ...spot, v: sim.v, trip: sim.tripTime, stopped: sim.stoppedTime } };
  }

  /** Машина из сохранения снова на дороге — там же, где была, с маршрутом до своей станции заново. */
  private placeOnRoad(v: FleetVehicle, spot: RoadSpot): Vehicle | null {
    const m = MODELS[v.model];
    const line = this.lines.get(v.lineId);
    const to = line && this.stations.get(line.stops[v.stop]);
    // У остановки (стоит или доезжает до места) автобус тоже на дороге — уже за её узлом: цель — следующая
    // остановка, а стоит он там же, где был.
    const onStop = (v.state === 'loading' || !!v.boarding) && !!to && onRoadStop(to);
    if (m.mode !== 'road' || (v.state !== 'driving' && !onStop) || !line || !to) return null;
    const next = onStop ? this.stations.get(line.stops[(v.stop + 1) % line.stops.length]) : to;
    if (!next) return null;
    const load = v.cargo ? CARGO[v.cargo].color : undefined;
    const sim = this.traffic.place({ ...m.spec, color: line.color, load, tank: this.isTanker(v), targetNode: next.nodeId }, spot.pos, spot.dir, spot.v);
    if (!sim) return null;
    if (onStop) {
      this.traffic.holdAfter(sim, 0);
      // Стоял у бордюра — там же и встаёт.
      this.traffic.toCurb(sim);
    }
    sim.tripTime = spot.trip;
    sim.stoppedTime = spot.stopped;
    this.owners.set(sim.id, { type: 'fleet', id: v.id });
    v.simId = sim.id;
    // Едет к получателю: путь — до связи у его двора, там свернёт к рампе (не вышло — доедет до узла и заедет снова).
    if (!onStop && next.kind === 'dock') this.dockApproach(sim, v, next);
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

  /**
   * Пары остановок после загрузки: вторая половина есть и считает парой эту — иначе остановка обычная. Сторона узла
   * (LaneNode.arrive) сохраняется с дорогами; у пары она ставится заново — по навесу.
   */
  private checkPairs(): void {
    for (const st of this.stations.values()) {
      if (st.pair === undefined) continue;
      if (this.pairOf(st)) this.setStopSide(st, true);
      else delete st.pair;
    }
    this.stationRev++;
  }

  /**
   * После загрузки: станции у получателей — узел по нынешней сети; без маршрутов — убираются (игрок кликнул по
   * магазину и не достроил маршрут); грузовики, что стояли во дворе или выезжали, — у рампы (манёвры не сохраняются).
   */
  private restoreDocks(): void {
    for (const st of [...this.stations.values()]) {
      if (st.kind !== 'dock') continue;
      if (!this.stationLines(st.id).length) {
        this.stations.delete(st.id);
        continue;
      }
      this.refreshDock(st);
      this.computeCatchment(st);
    }
    for (const v of this.fleet.values()) {
      const line = this.lines.get(v.lineId);
      const st = line && this.stations.get(line.stops[v.stop]);
      if (!st || st.kind !== 'dock' || v.simId !== null || (v.state !== 'loading' && v.state !== 'departing')) continue;
      const b = this.dockBuilding(st);
      const m = MODELS[v.model];
      if (b && m.mode === 'road') this.docks.stand(v.id, b, m.spec.length, m.spec.width);
    }
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
      if ((v.state === 'driving' || v.state === 'loading') && v.simId !== null && sims.has(v.simId)) continue;
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
    for (const e of save.terraform ?? []) this.terrain.terraform(e);
    this.net.load(save.net);
    // Полосы стоянки старых сохранений: уже (LaneNet.fromJSON, fitParkOffsets) и у перекрёстков — не до площадки.
    const roads = LaneNet.fromJSON(save.roads);
    fitCurbNet(roads);
    this.roads.replace(roads);
    this.construction.load(save.construction);
    // Загрузка стройки могла починить полотна (прежняя дорога у перестройки) — граф движения по ним.
    this.roads.changed();
    for (const b of this.construction.crews.bases.values()) this.index.add(b);
    // Сохранения, где ворота базы ссылаются на пропавший узел (перенос дороги у базы до исправления), — ворота заново.
    this.healBaseGates();
    this.towns = save.towns;
    /** Население городов, чьи жильцы разложены заново: до пересчёта (для целей сценария). */
    const was = new Map<number, number>();
    for (const t of this.towns) {
      // Ярус старого сохранения — по его населению и прежним порогам, пока жильцы не разложены заново.
      if (!t.tier) t.tier = townTier(t);
      // Дома, которые город по прежним правилам поставил прямо на пути, сносим.
      const clear = t.buildings.filter((b) => b.kind === 'landmark' || !onRail(this.net, b.fp, 0));
      if (clear.length < t.buildings.length) {
        t.buildings = clear;
        recountPopulation(t);
      }
      for (const b of t.buildings) this.index.add(b);
      // Дома старых сохранений: сторона улицы — по ближайшей улице (тип застройки — в measureTown).
      for (const b of t.buildings) if (b.face === undefined) b.face = streetFace(this.roads.net, b.fp);
      // Дома второго ряда (без заезда и гаража) — у старых сохранений по расстоянию до улицы.
      if (t.settled !== SETTLE_RULE) for (const b of t.buildings) if (b.kind === 'res' && b.rear === undefined && rearByGap(this.roads.net, b)) b.rear = true;
      // Жильцы по прежнему правилу (14 на этаж или с переездом лишних в многоквартирные) — заново, по нынешнему:
      // в частном доме 3–6 человек, в селе — 1–3 многоквартирных дома (townForms.settlePeople).
      if (t.settled !== SETTLE_RULE) {
        was.set(t.id, t.population);
        for (const b of t.buildings) if (b.kind === 'res') delete b.people;
        t.settled = SETTLE_RULE;
      }
      // Радиус старых сохранений — по самому дальнему дому; теперь — по плотной застройке.
      measureTown(t);
    }
    if (save.scenario && was.size) rescalePopulation(save.scenario, this.towns, was);
    // Застроенные до отказа улицы — как в партии до сохранения: рост города после загрузки тот же.
    for (const [id, month] of save.fullStreets ?? []) this.fullStreets.set(id, month);
    // Старые сохранения без переходов (и новые подъезды) — «само» по домам вокруг.
    if (this.syncCrosswalks()) this.roads.changed();
    this.industries = save.industries.map(({ kind, ...rest }) => ({ ...rest, type: 'industry', info: INDUSTRY_TYPES[kind] }));
    for (const ind of this.industries) this.index.add(ind);
    this.enterprises.load(save.deposits);
    for (const s of save.stations) {
      const st = this.stationFromSave(s);
      this.stations.set(st.id, st);
      // Станция у получателя невидима: на карте — сам магазин, по клику выбирается он.
      if (st.kind !== 'dock') this.index.add(st);
    }
    this.checkPairs();
    this.indexWarehouses();
    // Старые сохранения без парков: парки и скверы — на пустом месте по сохранённым домам и дорогам (townParks.ts).
    const towns = this.towns.filter((t) => !t.parks);
    if (towns.length) {
      const site = parkSite(this.worldContext());
      for (const t of towns) placeParks(t, site);
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
    this.orientStandingTrains();
    this.history.push(...save.history);
    this.time = save.time;
    this.month = save.month;
    this.money = save.money;
    this.incomeMonth = save.incomeMonth;
    this.expensesMonth = save.expensesMonth;
    this.ledger = { ...emptyLedger(), ...save.ledger };
    this.loan = save.loan ?? 0;
    // Старое сохранение (всё списывалось в конце месяца): начисление — с начала месяца (SaveData.upkeep).
    const { at, ...due } = save.upkeep ?? { at: this.month * MONTH_LENGTH, crews: 0, roads: 0, interest: 0 };
    this.upkeepAt = at;
    this.upkeepDue = { ...due };
    this.nextEntityId = save.nextEntityId;
    this.rng.seedState = save.rng;
    if (save.scenario) this.attachScenario(Scenario.restore(this, save.scenario));
    if (save.ideas) this.ideas = new Ideas(this, save.ideas);
    this.unlocks = save.unlocks ? new ModelUnlocks(save.unlocks) : this.legacyUnlocks(save);
    // Восстановленный счёт старой партии мог уже дойти до порога — модель открывается сразу, с заметкой.
    this.modelsReached(this.unlocks.reached());
    this.journal.add('load', { date: this.dateLabel, money: this.money, lines: this.lines.size, fleet: this.fleet.size });
    // Парк машин жителей: старое сохранение (прежний учёт гаражей) — переносится, остальные машины дома. Площадки —
    // по сохранению (Town.lots), машины на них — TownCar.lot, ls; в поиске места никого (в пути машины не сохраняются).
    this.lotRev++;
    this.parkSearch.clear();
    this.carHomes.load(this.towns);
    // Старые сохранения (без машин на стоянках магазинов) — машины на стоянках, как в начале партии.
    this.shops.seed(this.towns);
    // Получатели грузов: у партии с ними — как сохранены (у города без них — подбор заново); станции у получателей —
    // узел по нынешней сети, без маршрутов — убрать; грузовики, что были во дворе, — у рампы.
    if (this.retail) for (const t of this.towns) if (!t.receivers) this.refreshReceivers(t);
    this.restoreDocks();
    // Темп участков стройки зависит от застройки рядом (чистое поле): то, что посчитано по ходу загрузки, пока дома
    // и предприятия ещё не на месте, — заново.
    this.construction.forgetPrices();
    // Сохранение без таймлапса: запись начинается отсюда, с сети на момент загрузки.
    if (!this.timelapse.frames.length) this.timelapse.capture(this);
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
    const room = along / 2 - dockW / 2;
    let slide = Math.max(-room, Math.min(room, alongX ? ly : lx));
    // К этой стене уже подходит дорога и кончается тупиком у места выезда (стартовый просёлок): двор встаёт напротив
    // неё, где бы вдоль стены ни был курсор, — выезд продолжает дорогу, а не упирается ей в бок.
    const net = this.roads.net;
    for (const node of net.nodesNear(add(fp.center, scale(n, half + INDUSTRY_EXIT)), along / 2 + 10)) {
      const off = sub(node.pos, fp.center);
      const s = dot(off, axis);
      if (!net.isDeadEnd(node) || Math.abs(dot(off, n) - half - INDUSTRY_EXIT) > 6 || Math.abs(s) > room) continue;
      slide = s;
      break;
    }
    const at = (k: number) => add(add(fp.center, scale(axis, slide)), scale(n, half + k));
    // Площадка — в 3 м от стены, вглубь — фура (21 м) целиком на посту (bayPose: метр у стены, полметра до края) с
    // запасом; ворота — в 5 м за её краем. Старые дворы — 18 м вглубь (под фуру 18 м), фура там чуть выступает.
    const dock: Footprint = { center: at(3 + INDUSTRY_DOCK / 2), w: dockW, h: INDUSTRY_DOCK, angle: Math.atan2(n.x, -n.y) };
    const fail = (reason: string, cost = COST.station, driveway?: RoadPlan): StationPlan => ({
      ok: false,
      reason,
      cost,
      fp: dock,
      industryId: ind.id,
      driveway,
    });
    const gate = at(3 + INDUSTRY_DOCK + 5);
    const exit = at(INDUSTRY_EXIT);
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
  structuresUnder(fp: Footprint, margin: number, skip?: Structure, lots = true): { houses: number[]; blocker?: string } {
    const houses: number[] = [];
    // Площадки-стоянки — не в индексе построек: мешают так же, как станция.
    if (lots && this.lotUnder(fp, margin)) return { houses, blocker: 'Мешает площадка' };
    for (const s of this.index.near(fp.center, footprintRadius(fp) + margin + 120)) {
      if (s === skip || !footprintsOverlap(fp, s.fp, margin)) continue;
      if (s.type === 'building' && s.kind !== 'landmark') houses.push(s.id);
      else
        return {
          houses,
          blocker: s.type === 'building' ? 'Мешает ратуша' : s.type === 'industry' || s.type === 'annex' ? 'Мешает предприятие' : s.type === 'base' ? 'Мешает база' : 'Мешает станция',
        };
    }
    return { houses };
  }

  /** Сколько стоит снести эти дома. */
  demolishTotal(ids: number[]): number {
    return ids.reduce((sum, id) => sum + this.demolishCost(id), 0);
  }

  /**
   * Дорога или путь, задевающие площадку (с запасом pad), — проверяем по сетке точек внутри неё;
   * ответ — чем мешает. Полотна узла skipNode (выезд самой станции) не в счёт.
   */
  roadUnder(fp: Footprint, pad: number, skipNode: number | ReadonlySet<number> = -1, roads: LaneNet = this.roads.net): string | null {
    const skip = (id: number) => (typeof skipNode === 'number' ? id === skipNode : skipNode.has(id));
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
    for (const c of roads.corridorsNear(fp.center, footprintRadius(fp) + pad + 40)) {
      if (skip(c.a) || skip(c.b)) continue;
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
    const driveways = this.drivewayIds();
    return { roads: this.roads.net, terrain: this.terrain, index: this.index, rng: this.rng, nextId: () => this.nextEntityId++, rail: this.net, driveways };
  }

  /** Полотна выездов автостанций (у узла станции): они шоссе, но для города и других станций — как улицы. */
  private drivewayIds(): Set<number> {
    const ids = new Set<number>();
    for (const st of this.stations.values()) {
      // У станции вдоль дороги узел — на самой улице: выезда у неё нет.
      if (st.kind !== 'road' || st.side) continue;
      for (const id of this.roads.net.nodes.get(st.nodeId)?.corridors ?? []) ids.add(id);
    }
    // Тупики-выезды больших площадок — так же.
    for (const { lot } of this.lots.all()) for (const id of this.lotStubs(lot)) ids.add(id);
    return ids;
  }

  // ---------- BuildContext ----------

  /** Сколько можно потратить: до кредитного предела, без отложенного на проекты стройки (резерв). */
  get budget(): number {
    return this.money - ECONOMY.creditLimit - this.reserved;
  }

  /**
   * Бюджет автоматических трат стройки — проектов дорог и путей (construction.ts) и стройки предприятий
   * (enterprises.ts), что платят сами по готовым метрам: budget без запаса на содержание (upkeepReserve). Иначе
   * стройка тратила бы выручку до самого кредитного предела, а содержание, что списывается каждую секунду, тут же
   * уводило бы счёт ниже порога банкротства. Разовые покупки игрока смотрят на budget.
   */
  get buildBudget(): number {
    return this.budget - this.upkeepReserve;
  }

  /**
   * Запас на содержание: что спишется за ближайшие ECONOMY.upkeepReserve секунд игры (полмесяца) при нынешнем темпе
   * (upkeepForecast), с округлением вверх. Выручку не учитываем — она не обещана (стройка перекрывает дороги, машины
   * встают): пришла — сразу идёт в стройку, запас остаётся тем же.
   */
  get upkeepReserve(): number {
    return Math.ceil((this.upkeepForecast().total * ECONOMY.upkeepReserve) / MONTH_LENGTH);
  }

  /**
   * Темп списаний, $ в месяц: содержание транспорта и бригад, ремонт дорог и путей по нынешней стоимости сети,
   * проценты от нынешнего долга. Списывается непрерывно (accrueUpkeep): за полный месяц при том же парке, бригадах,
   * сети и долге — ровно столько; машина, купленная посреди месяца, — за остаток месяца.
   */
  upkeepForecast(): UpkeepForecast {
    const vehicles = this.fleetRunning();
    const crews = this.construction.crews.upkeep();
    const roads = this.roadUpkeep();
    const interest = this.interestDue();
    return { vehicles, crews, roads, interest, total: vehicles + crews + roads + interest };
  }

  /**
   * Сколько секунд игры счёт продержится над кредитным пределом, если выручки не будет: (деньги − предел) / темп
   * содержания. Ниже предела — 0, содержания нет — Infinity.
   */
  get upkeepRunway(): number {
    const over = this.money - ECONOMY.creditLimit;
    if (over <= 0) return 0;
    const perSecond = this.upkeepForecast().total / MONTH_LENGTH;
    return perSecond > 0 ? over / perSecond : Infinity;
  }

  /**
   * На грани банкротства: счёт ниже кредитного предела или содержание уведёт его туда быстрее ECONOMY.brinkSeconds
   * (upkeepRunway). Смотрит на счёт и темп расхода, а не на один порог: большой парк у порога опаснее малого.
   * Стройка держит запас вдвое больше (upkeepReserve) — грани сама не касается.
   */
  get nearBankrupt(): boolean {
    return this.upkeepRunway < ECONOMY.brinkSeconds;
  }

  /**
   * Ремонт дорог и путей за месяц. Стоимость сети (roadValueTotal) пересчитывается только с новой версией сети —
   * она меняется, когда участок открыт или начаты работы, а не на каждом шаге стройки.
   */
  private roadUpkeep(): number {
    // Площадки игрока — вместе с дорогами: LOT.upkeep их цены в месяц.
    return Math.round(this.roadValueTotal() * ECONOMY.roadUpkeepRate * 0.3) + this.lotsUpkeep();
  }

  /** Проценты по кредиту за месяц — от нынешнего долга. */
  private interestDue(): number {
    return this.loan > 0 ? Math.round(this.loan * ECONOMY.loanRate) : 0;
  }

  /**
   * Содержание за прошедший такт симуляции: каждой машине — её runningCost, бригадам — их содержание, ремонт — от
   * нынешней стоимости сети, проценты — от нынешнего долга; доля месячной суммы — по доле месяца, с дробью. Купил
   * посреди месяца — платишь за остаток, продал — начисление кончилось, взял кредит на неделю — проценты за неделю.
   * Раз в секунду игры (переход целой секунды) — платёж целыми долларами по каждой статье (payUpkeep), дробь копится
   * дальше; в конце месяца (monthEnd) остаток округляется — за полный месяц выходит ровно месячная сумма.
   * Начисляется в такте, не в кадре: сумма не зависит от того, как такты легли по кадрам. Отрезок — внутри месяца:
   * такт, перешагнувший конец месяца, начисляет до конца, остаток — уже следующему месяцу. Время, перепрыгнувшее
   * вперёд (старое сохранение посреди месяца, тесты), начисляется с upkeepAt разом.
   */
  private accrueUpkeep(dt: number): void {
    const start = this.month * MONTH_LENGTH;
    const from = Math.max(start, Math.min(this.upkeepAt, this.time - dt));
    const to = Math.min(this.time, start + MONTH_LENGTH);
    if (to <= from) return;
    this.upkeepAt = to;
    const f = (to - from) / MONTH_LENGTH;
    for (const v of this.fleet.values()) v.upkeepDue = (v.upkeepDue ?? 0) + this.runningCost(v) * f;
    const due = this.upkeepDue;
    due.crews += this.construction.crews.upkeep() * f;
    due.roads += this.roadUpkeep() * f;
    due.interest += this.interestDue() * f;
    if (Math.floor(to) > Math.floor(from)) this.payUpkeep(false);
  }

  /**
   * Платёж начисленного содержания: раз в секунду — целые доллары (дробь — дальше), в конце месяца (settle) —
   * остаток с округлением, накопители — в ноль. Статьи — как прежде в итогах месяца: транспорт и бригады —
   * «содержание транспорта» (у машины — в её прибыль и расходы её линии), ремонт, проценты.
   */
  private payUpkeep(settle: boolean): void {
    const whole = settle ? Math.round : Math.floor;
    for (const v of this.fleet.values()) this.payVehicleUpkeep(v, settle);
    const due = this.upkeepDue;
    const crews = whole(due.crews);
    const roads = whole(due.roads);
    const interest = whole(due.interest);
    this.upkeepDue = settle ? { crews: 0, roads: 0, interest: 0 } : { crews: due.crews - crews, roads: due.roads - roads, interest: due.interest - interest };
    this.chargeUpkeep(crews, 'vehicles');
    this.chargeUpkeep(roads, 'roads');
    this.chargeUpkeep(interest, 'interest');
    // Грань банкротства — по ходу месяца, когда счёт её переходит; в итогах месяца — напоминание (monthEnd).
    if (!settle) this.warnBrink(false);
  }

  /**
   * Начисленное машине — со счёта, в её прибыль и в расходы её линии: целые доллары, дробь — дальше; settle (конец
   * месяца, продажа) — остаток с округлением.
   */
  private payVehicleUpkeep(v: FleetVehicle, settle: boolean): void {
    const due = v.upkeepDue ?? 0;
    const a = settle ? Math.round(due) : Math.floor(due);
    v.upkeepDue = settle ? 0 : due - a;
    if (!a) return;
    this.chargeUpkeep(a, 'vehicles');
    v.profitMonth -= a;
    const line = this.lines.get(v.lineId);
    if (line) line.costMonth += a;
  }

  private chargeUpkeep(a: number, kind: 'vehicles' | 'roads' | 'interest'): void {
    if (!a) return;
    this.money -= a;
    this.expensesMonth += a;
    this.ledger[kind] += a;
  }

  /**
   * «Компания на грани банкротства!» (nearBankrupt): по ходу месяца — когда счёт переходит грань (не чаще раза в
   * месяц), в итогах месяца (monthly) — каждый месяц, пока он за ней.
   */
  private warnBrink(monthly: boolean): void {
    if (!this.nearBankrupt) return;
    if (!monthly && this.time - this.brinkAt < MONTH_LENGTH) return;
    if (monthly && this.time - this.brinkAt < 5) return;
    this.brinkAt = this.time;
    this.notify('Компания на грани банкротства!', '#e5534b', { kind: 'money' });
  }

  /** Отложено на проекты стройки (Project.reserve): на счёте, но не для прочих трат. */
  get reserved(): number {
    return this.construction.reserved();
  }

  /** Деньги на счёте без резерва стройки — для трат «если хватает денег» (авто-парк, гашение кредита). */
  get freeMoney(): number {
    return this.money - this.reserved;
  }

  // ---------- Стройка дорог (режим «Со строительством») ----------

  /** Партия «Со строительством»: нарисованная дорога — проект, строится со временем (construction.ts). */
  get buildMode(): boolean {
    return this.settings.construction === 'build';
  }

  /** RoadContext: под каким номером новая дорога станет проектом; «Мгновенно» — null. */
  projectId(): number | null {
    return this.buildMode ? this.construction.peekId() : null;
  }

  /** RoadContext: проект заложен — запись стройки, отмена действия знает, что оно заложило проект. */
  startProject(s: ProjectStart, net: LaneNet): void {
    const p = this.construction.start(s.id, net, s.corridors);
    const top = this.undoPending ? this.undoStack[this.undoStack.length - 1] : undefined;
    if (top) (top.creates ??= []).push(p.id);
    this.journal.add('project', { id: p.id, what: p.label, len: Math.round(s.length), $: s.cost, sec: Math.round(s.seconds) });
  }

  /**
   * BuildContext: под каким номером новый путь от узлов nodes станет ж/д проектом — продолжение строящегося пути (его
   * участок у одного из этих узлов) — тот же проект, иначе новый; «Мгновенно» — null.
   */
  railProjectId(nodes: number[]): number | null {
    if (!this.buildMode) return null;
    for (const n of nodes) {
      for (const sid of this.net.nodes.get(n)?.segments ?? []) {
        const id = this.net.segments.get(sid)?.build?.project;
        if (id !== undefined && this.construction.projects.get(id)?.rail) return id;
      }
    }
    return this.construction.peekId();
  }

  /** BuildContext: путь лёг проектом — запись стройки (или продолжение проекта), отмена действия знает о новом. */
  startRailProject(s: RailProjectStart): void {
    const fresh = !this.construction.projects.has(s.id);
    const p = this.construction.startRail(s.id, s.segments);
    if (!p) return;
    const top = this.undoPending ? this.undoStack[this.undoStack.length - 1] : undefined;
    if (top && fresh) (top.creates ??= []).push(p.id);
    this.journal.add('project', { id: p.id, what: p.label, len: Math.round(s.length), $: s.cost, sec: Math.round(s.seconds), ...(fresh ? {} : { more: true }) });
  }

  /** ConstructionHost: полная цена ж/д пути — за метр ж/д проект платит её долю. */
  railCost(seg: Segment): number {
    return this.builder.fullSegmentCost(seg);
  }

  /**
   * ConstructionHost: вокзалы игрока — депо строительных поездов (workTrains.ts), по номеру: где и платформы. Вокзал,
   * что сам стоит на строящемся пути (его платформа ещё строится), — не депо: поезду туда не попасть.
   */
  railDepots(): { id: number; pos: Vec; platforms: number[] }[] {
    const out: { id: number; pos: Vec; platforms: number[] }[] = [];
    for (const st of [...this.stations.values()].sort((a, b) => a.id - b.id)) {
      if (st.kind !== 'rail') continue;
      const platforms = st.platforms.filter((id) => this.net.segments.has(id));
      if (platforms.length && platforms.every((id) => !this.net.segment(id).build)) out.push({ id: st.id, pos: st.fp.center, platforms });
    }
    return out;
  }

  /** Стройка: проект достроен или встал без денег. */
  projectEvent(kind: 'done' | 'stalled', p: Project): void {
    if (kind === 'done') {
      // Клик по уведомлению — камера к достроенной улице.
      const a = p.area;
      const at = a ? { pos: { x: (a[0] + a[2]) / 2, y: (a[1] + a[3]) / 2 }, r: Math.max(80, Math.hypot(a[2] - a[0], a[3] - a[1]) / 2 + 40) } : undefined;
      this.notify(`🚧 Стройка закончена: ${projectName(p)}`, '#3f9d5a', { kind: 'build', at, refs: [{ type: 'project', id: p.id }] });
      this.journal.add('project-done', { id: p.id, what: projectName(p), $: p.spent, sec: Math.round(this.time - p.created) });
    } else {
      // Встали сразу несколько — одно уведомление (советник покажет все).
      const others = [...this.construction.projects.values()].some((x) => x !== p && x.stalled !== undefined);
      const upkeep = this.upkeepReserve;
      const text = this.buildWaitsUpkeep
        ? `🚧 Стройка ждёт: ${usd(upkeep)} отложено на содержание на ${durationText(ECONOMY.upkeepReserve)} вперёд`
        : '🚧 Стройка стоит: не хватает денег';
      if (!others) this.notify(text, '#e5534b', { kind: 'build', refs: [{ type: 'project', id: p.id }] });
      this.journal.add('project-stall', { id: p.id, money: this.money, upkeep });
    }
  }

  /**
   * Стройка стоит не потому, что денег нет до кредитного предела, а из-за запаса на содержание (buildBudget,
   * upkeepReserve): сверх предела на счёте что-то есть, но не больше, чем спишется за ближайшие полмесяца.
   */
  get buildWaitsUpkeep(): boolean {
    return this.budget > 0;
  }

  /** Пауза проекта (paused) или снова строить. */
  pauseProject(id: number, paused: boolean): void {
    if (!this.construction.projects.has(id)) return;
    this.construction.setPaused(id, paused);
    this.journal.add('project-pause', { id, on: paused });
  }

  /**
   * Резерв проекта: on — отложить, сколько ещё стоит достроить (не хватает свободных денег — сколько есть; уже
   * отложено меньше — доложить), off — снять. Отложенное остаётся на счёте, но в бюджет прочих трат не входит, а проект
   * платит из него (construction.ts). Откладывается из бюджета стройки (buildBudget): запас на содержание
   * (upkeepReserve) стройка не тратит и из резерва, поэтому отложить его — значит запереть деньги, которые проекту не
   * достанутся.
   * null — сделано, иначе причина.
   */
  reserveProject(id: number, on: boolean): string | null {
    const p = this.construction.projects.get(id);
    if (!p) return 'Нет проекта';
    if (!on) {
      if (!p.reserve) return null;
      this.construction.setReserve(id, 0);
      this.journal.add('project-reserve', { id, $: 0 });
      return null;
    }
    const left = this.construction.info(id)?.left ?? 0;
    const have = p.reserve ?? 0;
    const add = Math.min(left - have, Math.floor(this.buildBudget));
    if (left - have <= 0) return null;
    if (add <= 0) return 'Не хватает денег';
    this.construction.setReserve(id, have + add);
    this.journal.add('project-reserve', { id, $: have + add, left });
    return null;
  }

  /** Своё название проекта: пробелы по краям обрезаются, не длиннее 40; пустое — снова автоматическое (label). */
  renameProject(id: number, name: string): void {
    const p = this.construction.projects.get(id);
    if (!p) return;
    const clean = name.trim().slice(0, 40);
    if (clean === projectName(p)) return;
    if (clean && clean !== p.label) p.name = clean;
    else delete p.name;
    this.construction.stamp++;
    this.journal.add('project-name', { id, name: projectName(p), auto: p.name === undefined });
  }

  /**
   * Перекрытие перестройки проекта id (rebuild.ts, closure.ts): part — по полосам (часть прежних полос открыта на
   * скорости зоны работ, стройка дольше), иначе целиком (объезд, быстрее). Граф движения — заново.
   */
  setProjectClosure(id: number, part: boolean): void {
    if (!this.construction.setClosure(id, part)) return;
    this.networkChanged();
    this.journal.add('project-closure', { id, part });
  }

  /** Приоритет проекта (on) или снова обычный: бригады — сначала к нему (crews.ts). */
  prioritizeProject(id: number, on: boolean): void {
    if (!this.construction.projects.has(id)) return;
    this.construction.setPriority(id, on);
    this.journal.add('project-priority', { id, on });
  }

  /**
   * Отмена проекта: недостроенные участки сносятся, заплаченное за начатый, но не готовый участок — назад,
   * готовые участки остаются (они уже дороги — снос по обычным правилам). Одним шагом для Ctrl+Z. false — нет проекта.
   */
  cancelProject(id: number, undoable = true): boolean {
    const p = this.construction.projects.get(id);
    if (!p) return false;
    if (p.rail) {
      // Ж/д проект: недостроенные пути — прочь, заплаченное за них — назад целиком. Путь под станцией (платформа)
      // не сносится — его проект достраивает.
      const segs = this.construction.segmentsOf(id);
      const back = segs.reduce((s, x) => s + (x.platform === undefined ? this.builder.segmentCost(x) : 0), 0);
      if (undoable) this.checkpoint('отмена стройки');
      this.builder.bulldozeSegments(
        segs.map((x) => x.id),
        false,
      );
      this.money += back;
      this.expensesMonth -= back;
      this.ledger.build -= Math.min(this.ledger.build, back);
      if (!this.construction.segmentsOf(id).length) this.construction.projects.delete(id);
      this.construction.prune();
      this.journal.add('project-cancel', { id, what: projectName(p), back, built: Math.round(p.builtLen) });
      if (undoable) this.commit();
      return true;
    }
    const cs = this.construction.corridorsOf(id);
    const water = (q: Vec, m?: number) => this.isWater(q, m);
    // Перестройка готовой дороги (rebuild.ts) — назад прежней дорогой (а не сносом), заплаченное за работы — назад.
    const redo = cs.filter((c) => c.build?.was);
    const fresh = cs.filter((c) => !c.build?.was);
    const back =
      fresh.reduce((s, c) => s + corridorCost(this.roads.net, c, water, this.ground()), 0) +
      redo.reduce((s, c) => s + paidFor(c.build!.was!.price, c.build!.done, c.length), 0);
    if (undoable) this.checkpoint('отмена стройки');
    const plan = redo.length
      ? this.roadBuilder.plan(
          (n) => {
            for (const c of fresh) bulldoze(n, c.id);
            revertRebuild(
              n,
              redo.map((c) => c.id),
            );
          },
          { raze: true },
        )
      : this.roadBuilder.bulldoze(cs.map((c) => c.id));
    // Снос недостроенного — без «возврата половины»: заплаченное за него возвращается целиком (ниже).
    if (plan.net) this.roadBuilder.apply({ ...plan, ok: true, spend: 0, refund: 0, demolish: [] });
    this.money += back;
    this.expensesMonth -= back;
    this.ledger.build -= Math.min(this.ledger.build, back);
    this.construction.projects.delete(id);
    this.construction.prune();
    this.journal.add('project-cancel', { id, what: projectName(p), back, built: Math.round(p.builtLen) });
    if (undoable) this.commit();
    return true;
  }

  /** Дороги для строительной техники: подъезд без учёта направления полос и шаги пути бригады (crewRoads.ts). */
  private readonly crewRoads = new CrewRoads();

  /**
   * Стройка (construction.ts, crews.ts): от узла from до узла to технике можно добраться по готовым дорогам — без учёта
   * направления полос (едет она по правилам, а где по ним не доехать — отрезок против движения, crewStep). Ответы
   * запоминаются до смены графа движения.
   */
  reach(from: number, to: number): boolean {
    return this.crewRoads.reach(this.roads.graph, from, to);
  }

  /** Стройка (crews.ts): следующий шаг бригады от узла from к узлу to — по дорогам в потоке или против движения. */
  crewStep(from: number, to: number): CrewStep | null {
    return this.crewRoads.step(this.roads.graph, from, to);
  }

  /** Стройка: бригада разворачивается через обе половины полотна — реверс на красный обеим сторонам (WorkSignals.hold). */
  turnGate(corridor: number): boolean {
    return this.workSignals.hold(corridor);
  }

  /** Стройка: бригада вот-вот расширит участок под реверсом — можно ли (WorkSignals.grow). */
  zoneGate(corridor: number, build: CorridorBuild): boolean {
    return this.workSignals.grow(this.roads.net, this.roads.graph, corridor, build);
  }

  /** Машина car колонны бригады b (CREW_CARS): на ж/д стройке — в цвете путейцев (RAIL_CREW_COLOR). */
  private crewCar(b: Brigade, car: number): (typeof CREW_CARS)[number] {
    const spec = CREW_CARS[Math.min(car, CREW_CARS.length - 1)];
    const rail = b.project !== undefined && !!this.construction.projects.get(b.project)?.rail;
    return rail ? { ...spec, color: RAIL_CREW_COLOR } : spec;
  }

  /**
   * Стройка (crews.ts): машина колонны бригады (car — её номер, CREW_CARS) — в поток от узла from к узлу to; 'busy' —
   * путь есть, но на выезде нет места; null — пути по дорогам нет (по полю бригады не ездят — к такому проекту они не
   * едут). Все машины колонны принадлежат бригаде: клик по любой — её карточка (crewOfSim).
   */
  drive(b: Brigade, from: number, to: number, car = 0): number | 'busy' | null {
    const route = this.roads.route(from, to);
    if (!route) return null;
    const sim = this.traffic.spawn({ ...this.crewCar(b, car), targetNode: to, route });
    if (!sim) return 'busy';
    this.owners.set(sim.id, { type: 'crew', id: b.id });
    return sim.id;
  }

  /**
   * Стройка (crews.ts): машина колонны — в поток прямо с места spot, где она стоит на готовой дороге (кончили участок,
   * колонна собралась у подъезда), к узлу to: на попутную полосу под ней, носом туда же. Полосы под ней нет (стоит на
   * стройке, на площадке узла) или до цели оттуда не доехать — null: выедет от узла (drive).
   */
  driveFrom(b: Brigade, car: number, spot: { pos: Vec; dir: Vec }, to: number): number | 'busy' | null {
    const spec = this.crewCar(b, car);
    // Выезжают по одной: следующая трогается, когда предыдущая отъехала на свою длину с запасом (у тупика та
    // разворачивается и проезжает мимо — не задевая стоящую). Та, что развернётся петлёй у дороги (crewLoop.ts), — не
    // помеха: следующая выезжает за ней и съезжает в свою полосу, а их по очереди разводят развороты (регулировщик не
    // пустит её туда, где та развернётся, — и та не поедет мимо, пока эта не в своей полосе).
    for (const c of b.convoy?.cars.slice(0, car) ?? []) {
      const prev = 'sim' in c ? this.traffic.vehicles.get(c.sim) : undefined;
      if (prev && !this.crewLoops.turning(prev.id) && dist(prev.pos, spot.pos) < prev.length + 14) return 'busy';
    }
    // Попутная полоса — и через полосу: бригада, работавшая в ряду у другой кромки (несколько бригад на 1+1), стоит
    // над встречной; иначе её машина выезжала от узла — у тупика скачком к его торцу и сразу носом назад.
    const reach = 2 * LANE_W;
    const sim = this.traffic.place({ ...spec, targetNode: to }, spot.pos, spot.dir, 0, reach);
    if (!sim) return null;
    // Полоса нашлась далеко (машина не на ней, а рядом — за концом дороги): не перескакиваем — выедет от узла.
    const off = sub(spot.pos, sim.pos);
    const lat = dot(off, rightNormal(sim.dir));
    if (Math.abs(lat) > reach || Math.abs(dot(off, sim.dir)) > 1.5 || dot(sim.dir, spot.dir) < 0.9) {
      this.traffic.remove(sim);
      return null;
    }
    // Стоит на оси дороги, а не посреди полосы: там и остаётся, а в полосу съезжает на ходу (glide), не боком; корпус —
    // как стоял (задняя ось и вторая часть — прямо позади носа).
    sim.lateral = lat;
    sim.glide = true;
    const h = hitchOf(sim.body);
    sim.rear = sub(spot.pos, scale(spot.dir, steerBase(sim.body) * sim.length));
    if (h) sim.trail = sub(spot.pos, scale(spot.dir, (h.joint + h.tail) * sim.length));
    else delete sim.trail;
    this.traffic.updatePose(sim);
    this.owners.set(sim.id, { type: 'crew', id: b.id });
    return sim.id;
  }

  /**
   * Стройка (crews.ts): машины колонны бригады b, что в потоке, едут к узлу to — сразу, кратчайшим путём оттуда, где
   * каждая сейчас. Всё или ничего: хоть одной туда по правилам не доехать — false, все едут как ехали.
   */
  redirect(b: Brigade, to: number): boolean {
    const cars: { sim: Vehicle; route: number[] }[] = [];
    for (const c of b.convoy?.cars ?? []) {
      if (!('sim' in c)) continue;
      const sim = this.traffic.vehicles.get(c.sim);
      const route = sim && this.traffic.routeFrom(sim, to);
      if (!sim || !route) return false;
      cars.push({ sim, route });
    }
    for (const { sim, route } of cars) {
      this.traffic.redirect(sim, to, route);
      // Ждала у прежнего конца пути остальных (crewAssembled) — больше не ждёт: едет дальше.
      this.crewWaitSince.delete(sim.id);
    }
    return true;
  }

  /** Стройка: машина бригады больше не нужна — с дороги долой. */
  park(sim: number): void {
    const v = this.traffic.vehicles.get(sim);
    if (v) this.traffic.remove(v);
    this.owners.delete(sim);
  }

  /** Стройка: узел есть в графе движения — до него можно доехать по дороге. */
  onRoad(node: number): boolean {
    const g = this.roads.graph;
    return g.outLinks.has(node) || g.inLinks.has(node);
  }

  /**
   * Где встанет строительная база у точки p: площадка вдоль ближайшей открытой дороги, с той стороны, где курсор;
   * ворота — ближайший узел этой дороги, куда можно доехать. Дома под площадкой сносятся (за доплату),
   * станции, предприятия, дороги, пути и вода мешают. free — бесплатно: первую базу игрок ставит сам и даром.
   */
  basePlan(p: Vec, free = this.firstBase): { ok: boolean; reason?: string; cost: number; fp: Footprint | null; nodeId?: number; demolish: number[] } {
    const B = CONSTRUCTION.base;
    const net = this.roads.open;
    const cost0 = free ? 0 : B.cost;
    const fail = (reason: string, fp: Footprint | null = null) => ({ ok: false, reason, cost: cost0, fp, demolish: [] as number[] });
    const c = net.corridorNear(p, 90);
    if (!c) return fail('Поставьте рядом с дорогой');
    const hit = c.lut.closest(p);
    const t = c.lut.tangentAt(hit.s);
    const n = rightNormal(t);
    const side = dot(sub(p, hit.point), n) >= 0 ? 1 : -1;
    const off = corridorHalf(c) + B.gap + B.h / 2;
    const fp: Footprint = { center: add(hit.point, scale(n, side * off)), w: B.w, h: B.h, angle: Math.atan2(t.y, t.x) };
    if (!this.inBounds(fp.center, 40)) return fail('За краем карты', fp);
    if (footprintCorners(fp).some((q) => this.isWater(q, 2)) || this.isWater(fp.center, 2)) return fail('Мешает вода', fp);
    if (net.node(c.a).level !== 0 || net.node(c.b).level !== 0) return fail('Нужна дорога на земле', fp);
    const under = this.structuresUnder(fp, 1);
    if (under.blocker) return fail(under.blocker, fp);
    const road = this.roadUnder(fp, 1);
    if (road) return fail(road, fp);
    // Ворота: ближайший к площадке узел, куда можно доехать (конец этой дороги или узел рядом).
    const nodes = [c.a, c.b, ...net.nodesNear(hit.point, 400).map((x) => x.id)].filter((id) => this.onRoad(id));
    const gate = nodes.sort((x, y) => dist(net.node(x).pos, hit.point) - dist(net.node(y).pos, hit.point) || x - y)[0];
    if (gate === undefined) return fail('Нет подъезда по дороге', fp);
    const cost = cost0 + this.demolishTotal(under.houses);
    if (cost > this.budget) return { ok: false, reason: 'Не хватает денег', cost, fp, demolish: under.houses };
    return { ok: true, cost, fp, nodeId: gate, demolish: under.houses };
  }

  /** Ставит строительную базу у точки p (с бригадами по умолчанию). null — поставили, иначе причина. */
  buildBase(p: Vec, free = this.firstBase): string | null {
    const plan = this.basePlan(p, free);
    if (!plan.ok || !plan.fp || plan.nodeId === undefined) return plan.reason ?? 'Нельзя';
    // База в отмену (Ctrl+Z) не входит: снесённые под ней дома прежние снимки вернули бы под площадку — забываем их.
    if (plan.demolish.length) {
      this.demolish(plan.demolish);
      this.forgetUndo();
    }
    if (plan.cost) this.spend(plan.cost);
    const base: BuildBase = { type: 'base', id: this.nextEntityId++, fp: plan.fp, nodeId: plan.nodeId, paid: free ? 0 : CONSTRUCTION.base.cost };
    this.construction.crews.bases.set(base.id, base);
    this.construction.crews.firstUsed = true;
    this.index.add(base);
    for (let i = 0; i < CONSTRUCTION.base.brigades; i++) this.construction.crews.hire(base.id);
    this.construction.stamp++;
    this.journal.add('base', { id: base.id, pos: [Math.round(base.fp.center.x), Math.round(base.fp.center.y)], $: plan.cost });
    return null;
  }

  /**
   * Перенос базы id к точке p: место и ворота — как при постановке (basePlan), только сама база себе не мешает и
   * платы за базу нет — платится лишь снос домов на новом месте.
   */
  baseMovePlan(id: number, p: Vec): ReturnType<Game['basePlan']> {
    const base = this.construction.crews.bases.get(id);
    if (!base) return { ok: false, reason: 'Нет базы', cost: 0, fp: null, demolish: [] };
    this.index.remove(base);
    try {
      return this.basePlan(p, true);
    } finally {
      this.index.add(base);
    }
  }

  /**
   * Переносит базу id к точке p (снимок для Ctrl+Z делает тот, кто переносит, — как у переноса станции). Работающие
   * бригады продолжают, домой вернутся уже сюда; свободные едут сюда по дорогам (Crews.moveBase). null — перенесли.
   */
  moveBase(id: number, p: Vec): string | null {
    const base = this.construction.crews.bases.get(id);
    const plan = this.baseMovePlan(id, p);
    if (!base || !plan.ok || !plan.fp || plan.nodeId === undefined) return plan.reason ?? 'Нельзя перенести';
    const from = [Math.round(base.fp.center.x), Math.round(base.fp.center.y)];
    if (plan.demolish.length) this.demolish(plan.demolish);
    if (plan.cost) this.spend(plan.cost);
    this.relocateBase(base, plan.fp, plan.nodeId);
    this.journal.add('base>', { id, name: this.baseName(id), from, pos: [Math.round(plan.fp.center.x), Math.round(plan.fp.center.y)], $: plan.cost, razed: plan.demolish.length || undefined });
    return null;
  }

  /** База — на новое место fp с воротами nodeId; бригады — следом (Crews.moveBase). */
  private relocateBase(base: BuildBase, fp: Footprint, nodeId: number): void {
    const from = { pos: { ...base.fp.center }, node: base.nodeId };
    this.index.remove(base);
    base.fp = fp;
    base.nodeId = nodeId;
    this.index.add(base);
    this.construction.crews.moveBase(base.id, from);
    this.construction.stamp++;
  }

  /**
   * Ворота строительных баз, чей узел пропал из сети дорог (дорогу у базы перенесли, стык слился, улицу снесли):
   * новые ворота — как при постановке (basePlan), ближайший к площадке узел ближней дороги, куда можно доехать;
   * таких нет — ближайший узел сети. Без этого стройки базы искали путь от несуществующего узла («Нет узла N»).
   */
  private healBaseGates(): void {
    const net = this.roads.net;
    if (!net.nodes.size) return;
    for (const base of this.construction.crews.bases.values()) {
      if (net.nodes.has(base.nodeId)) continue;
      const gate = this.baseGate(base.fp.center);
      if (gate !== null) this.relocateBase(base, base.fp, gate);
    }
  }

  /** Ворота для площадки у точки at: узел ближней открытой дороги, куда можно доехать (как в basePlan), иначе ближайший узел. */
  private baseGate(at: Vec): number | null {
    const net = this.roads.net;
    const c = this.roads.open.corridorNear(at, 90);
    const near = c ? c.lut.closest(at).point : at;
    const ids = [...(c ? [c.a, c.b] : []), ...net.nodesNear(near, 400).map((x) => x.id)].filter((id) => net.nodes.has(id));
    const byDist = (x: number, y: number) => dist(net.node(x).pos, near) - dist(net.node(y).pos, near) || x - y;
    const road = ids.filter((id) => this.onRoad(id)).sort(byDist)[0];
    if (road !== undefined) return road;
    if (ids.length) return ids.sort(byDist)[0];
    let best: number | null = null;
    for (const n of net.nodes.values()) if (best === null || byDist(n.id, best) < 0) best = n.id;
    return best;
  }

  /** Ещё бригада на базе: цена — сразу, содержание — каждый месяц. null — наняли, иначе причина. */
  hireBrigade(base: number): string | null {
    const crews = this.construction.crews;
    if (!crews.bases.has(base)) return 'Нет базы';
    if (crews.of(base).length >= CONSTRUCTION.base.maxBrigades) return `На базе не больше ${CONSTRUCTION.base.maxBrigades} бригад`;
    if (CONSTRUCTION.brigade.cost > this.budget) return 'Не хватает денег';
    this.spend(CONSTRUCTION.brigade.cost, 'purchases');
    crews.hire(base);
    this.construction.stamp++;
    this.journal.add('brigade', { base, n: crews.of(base).length, $: CONSTRUCTION.brigade.cost });
    return null;
  }

  /** Распустить бригаду базы (свободную — первой): половина цены — назад. */
  dismissBrigade(base: number): boolean {
    const crews = this.construction.crews;
    if (crews.of(base).length <= 0) return false;
    crews.dismiss(base);
    this.refund(CONSTRUCTION.brigade.cost);
    this.construction.stamp++;
    this.journal.add('brigade', { base, n: crews.of(base).length, sold: true });
    return true;
  }

  /**
   * «Со строительством» баз ещё не было: первую игрок ставит сам, где хочет, — бесплатно. Снёс все базы — следующая
   * уже платная (crews.firstUsed хранится в сохранении), иначе базу можно было бы сносить и ставить даром.
   */
  get firstBase(): boolean {
    const crews = this.construction.crews;
    return this.buildMode && crews.bases.size === 0 && !crews.firstUsed;
  }

  /**
   * Что будет, если снести базу id: возврат (половина заплаченного за неё; первая была бесплатной — ничего), куда
   * перейдут бригады (ближайшая из других баз) или сколько вернут за распущенные (других баз нет). null — базы нет.
   */
  baseRemovePlan(id: number): { refund: number; to: number | null; brigades: number; dismissRefund: number } | null {
    const crews = this.construction.crews;
    const base = crews.bases.get(id);
    if (!base) return null;
    const refund = Math.round((base.paid ?? CONSTRUCTION.base.cost) * COST.refundRatio);
    let to: { id: number; d: number } | null = null;
    for (const b of crews.bases.values()) {
      if (b.id === id) continue;
      const d = dist(b.fp.center, base.fp.center);
      if (!to || d < to.d - 1e-6) to = { id: b.id, d };
    }
    const n = crews.of(id).length;
    return { refund, to: to?.id ?? null, brigades: n, dismissRefund: to ? 0 : n * Math.round(CONSTRUCTION.brigade.cost * COST.refundRatio) };
  }

  /**
   * Сносит строительную базу id: половина заплаченного за неё — назад (первая была бесплатной); бригады — на ближайшую
   * другую базу (работающие доделывают своё, только база у них новая), других нет — распускаются с возвратом половины
   * цены, как «−». В отмену (Ctrl+Z) не входит, как и постановка базы. null — снесли, иначе причина.
   */
  removeBase(id: number): string | null {
    const plan = this.baseRemovePlan(id);
    const base = this.construction.crews.bases.get(id);
    if (!plan || !base) return 'Нет базы';
    const name = this.baseName(id);
    this.index.remove(base);
    const gone = this.construction.crews.removeBase(id, this.onRoad(base.nodeId));
    if (plan.refund) this.refund(base.paid ?? CONSTRUCTION.base.cost);
    for (let i = 0; i < gone.length; i++) this.refund(CONSTRUCTION.brigade.cost);
    this.construction.stamp++;
    this.journal.add('base-', { id, name, back: plan.refund + plan.dismissRefund, to: plan.to ?? undefined, crews: plan.brigades });
    return null;
  }

  /**
   * Название базы: своё, если игрок его дал, иначе — ближайший город («Сосновка»); у второй базы того же города —
   * с номером («Сосновка 2», по порядку постройки).
   */
  baseName(id: number): string {
    const bases = this.construction.crews.bases;
    const base = bases.get(id);
    if (!base) return 'База';
    if (base.name) return base.name;
    const town = (b: BuildBase) => {
      let best: Town | undefined;
      let bd = Infinity;
      for (const t of this.towns) {
        const d = dist(t.center, b.fp.center) - t.radius;
        if (d < bd || (d === bd && best && t.id < best.id)) [best, bd] = [t, d];
      }
      return best?.name ?? 'База';
    };
    const own = town(base);
    const same = [...bases.values()].filter((b) => !b.name && b.id <= id && town(b) === own).length;
    return same > 1 ? `${own} ${same}` : own;
  }

  /**
   * Где бригада и что делает — для «показать на карте», карточки проекта и плашки базы: машина в потоке — где она
   * сейчас («едет по дороге»); вдоль стройки — где успела доехать (самосвал рисуется там же, Crews.walkAt); ждёт места
   * на выезде — откуда выезжает; на стройке — у края работ; свободна — на базе.
   */
  brigadeWhere(id: number): { pos: Vec; text: string } | null {
    const crews = this.construction.crews;
    const b = crews.brigades.get(id);
    if (!b) return null;
    const base = crews.bases.get(b.base);
    const home = base?.fp.center ?? b.pos ?? { x: 0, y: 0 };
    const info = b.project !== undefined ? this.construction.info(b.project) : null;
    const site = info ? (info.front ?? info.at) : null;
    const label = info ? `«${this.projectTitle(info.project.id)}»` : '';
    // Колонна в пути — где головная машина: в потоке или уже доехала и ждёт остальных; ещё не выехала — откуда выезжает.
    const head = b.convoy?.cars[0];
    const lead = crews.lead(b);
    const car = head && 'at' in head ? head.at : head && 'sim' in head ? this.traffic.vehicles.get(head.sim)?.pos : lead !== undefined ? this.traffic.vehicles.get(lead)?.pos : undefined;
    const walk = crews.walkAt(b);
    const toRoad = !!b.trip?.back;
    // Отрезок дороги против движения (там, где по правилам не доехать, — как будто стоит регулировщик).
    const against = b.trip?.to !== undefined;
    switch (b.state) {
      case 'working':
        // Край работ; работы ещё не начаты (первая машина едет к своему месту) — там, куда она едет.
        return { pos: info?.front ?? b.pos ?? site ?? home, text: `строит ${label}` };
      case 'going':
        if (car) return { pos: car, text: `едет по дороге строить ${label}` };
        if (walk && against) return { pos: walk.pos, text: `едет по дороге против движения (там регулировщик) строить ${label}` };
        if (walk) return { pos: walk.pos, text: toRoad ? `едет вдоль стройки к дороге, потом — строить ${label}` : `едет вдоль стройки к краю работ ${label}` };
        return { pos: b.pos ?? home, text: `ждёт выезда, чтобы ехать строить ${label}` };
      case 'back':
        if (car) return { pos: car, text: 'едет по дороге на базу' };
        if (walk && against) return { pos: walk.pos, text: 'едет по дороге против движения (там регулировщик) на базу' };
        if (walk) return { pos: walk.pos, text: 'едет вдоль стройки к дороге, потом — на базу' };
        return { pos: b.pos ?? home, text: 'ждёт выезда, чтобы ехать на базу' };
      default:
        return { pos: home, text: 'свободна, стоит на базе' };
    }
  }

  // ---------- Бригада как выбор на карте и назначение игроком (карточка бригады, crewCard.ts) ----------

  /**
   * Может ли бригада id поехать на проект project («🎯 На стройку…»): null — да; иначе причина понятными словами — нет
   * проекта, на паузе, нет подъезда (или ждёт соседний), места нет (cap), отсюда не доехать (Crews.canGo).
   */
  brigadeCanGo(id: number, project: number): string | null {
    const crews = this.construction.crews;
    const b = crews.brigades.get(id);
    if (!b) return 'Бригады больше нет';
    const info = this.construction.info(project);
    if (!info) return 'Проекта больше нет: достроен или отменён';
    const name = `«${this.projectTitle(project)}»`;
    if (info.project.paused) return `${name} на паузе — сначала «▶ Дальше»`;
    if (b.project === project && (b.state === 'going' || b.state === 'working')) return null;
    if (!info.access)
      return info.waits ? `${name}: подъезд — через соседний строящийся проект, туда пока не проехать` : `К ${name} нет подъезда: ни один конец не связан готовой дорогой с базой`;
    // Мест нет — проверка у Crews.canGo: уступит дальняя бригада, назначенная автоматикой (displaced).
    return crews.canGo(b, project);
  }

  /** Отправить бригаду id на проект project и закрепить её там (Crews.send): null — едет, иначе причина отказа. */
  sendBrigade(id: number, project: number): string | null {
    const problem = this.brigadeCanGo(id, project);
    if (problem) return problem;
    const crews = this.construction.crews;
    const b = crews.brigades.get(id)!;
    const was = b.project;
    // Мест нет — уступит дальняя бригада, назначенная автоматикой: скажем, какая.
    const full = b.project !== project && crews.assigned(project).length >= crews.cap(project);
    const out = full ? crews.displaced(b, project) : null;
    const fail = crews.send(b, project);
    if (fail) return fail;
    if (out) {
      const n = crews.of(out.base).indexOf(out) + 1;
      // Клик по уведомлению — к стройке и её карточке.
      this.notify(`🚚 Бригада ${n} базы «${this.baseName(out.base)}» уступила место на «${this.projectTitle(project)}»`, undefined, {
        refs: [{ type: 'project', id: project }],
      });
    }
    this.construction.stamp++;
    this.journal.add('brigade-send', { b: id, base: b.base, id: project, what: projectName(this.construction.projects.get(project)!), ...(was !== undefined && was !== project ? { from: was } : {}) });
    return null;
  }

  /** «↺ Авто»: снять закрепление бригады id — дальше её снова распределяет автоматика. */
  autoBrigade(id: number): void {
    const crews = this.construction.crews;
    const b = crews.brigades.get(id);
    if (!b?.pinned) return;
    crews.unpin(b);
    this.construction.stamp++;
    this.journal.add('brigade-auto', { b: id, base: b.base, ...(b.project !== undefined ? { id: b.project } : {}) });
  }

  /**
   * Машины бригады id на карте — для подсветки выбранной бригады: в потоке и вне его (вдоль стройки, ждут колонну),
   * середина кузова и радиус кольца. Техника на работе у края — у рисовальщика стройки (renderer, crewConvoy).
   */
  crewSpots(id: number): { pos: Vec; r: number }[] {
    const crews = this.construction.crews;
    const b = crews.brigades.get(id);
    if (!b) return [];
    const out: { pos: Vec; r: number }[] = [];
    for (const car of b.convoy?.cars ?? []) {
      const sim = 'sim' in car ? this.traffic.vehicles.get(car.sim) : undefined;
      if (sim) out.push({ pos: sub(sim.pos, scale(sim.dir, sim.length / 2)), r: sim.length * 0.9 + 3 });
    }
    for (const m of crews.carsAt(b)) {
      const s = CREW_CARS[Math.min(m.car, CREW_CARS.length - 1)];
      out.push({ pos: sub(m.pos, scale(m.dir, s.length / 2)), r: s.length * 0.9 + 3 });
    }
    return out;
  }

  /** Путь бригады по дорогам от узла к узлу (шаги crewStep) — до смены графа движения. */
  private crewPathCache: { graph: object; paths: Map<string, Vec[]> } | null = null;

  /**
   * Маршрут бригады id для карты (её выбрали, или её базу, или проект, куда она едет): от головной машины (в потоке —
   * по полосам, как у выбранной машины; вдоль стройки и против движения — остаток поездки; ждёт выезда — от узла)
   * шагами по дорогам (crewStep: по правилам и против движения) до узла подъезда, оттуда вдоль стройки до края работ
   * (goal). Едет домой — до ворот базы (goal — середина базы, home). Работает или стоит на базе — null.
   */
  brigadeRoute(id: number): { pts: Vec[]; goal: Vec; home: boolean; project?: number } | null {
    const crews = this.construction.crews;
    const b = crews.brigades.get(id);
    if (!b || (b.state !== 'going' && b.state !== 'back')) return null;
    const home = b.state === 'back';
    const base = crews.bases.get(b.base);
    const site = !home && b.project !== undefined ? this.construction.approach(b.project, b) : null;
    if (home ? !base : !site) return null;
    const target = home ? base!.nodeId : site!.node;
    const net = this.roads.net;
    const nodePos = (n: number) => (net.nodes.has(n) ? { ...net.node(n).pos } : null);
    const pts: Vec[] = [];
    // Узел, где кончается нынешний отрезок пути (дальше — шагами по дорогам); null — поездка уже к краю работ.
    let node: number | null;
    const trip = crews.tripAhead(b);
    if (b.convoy) {
      const lead = crews.lead(b);
      const ahead = lead !== undefined ? this.vehicleAhead(lead) : null;
      if (ahead) pts.push(...ahead.pts);
      else if (b.convoy.cars.every((c) => 'wait' in c)) {
        // Ещё не выехала: от места (или узла) выезда — по дорогам до цели этого шага.
        const from = b.pos ?? nodePos(b.convoy.from);
        if (from) pts.push(from);
        const route = this.roads.route(b.convoy.from, b.convoy.to);
        if (route) pts.push(...this.roads.routePolyline(route));
      }
      node = b.convoy.to;
    } else if (trip && b.trip) {
      pts.push(...trip);
      // Против движения — до узла дороги; назад вдоль стройки — к узлу, где съехала (b.at); иначе — к краю работ.
      node = b.trip.to ?? (b.trip.back ? (b.at ?? null) : null);
    } else {
      node = crews.startOf(b);
      const from = b.pos ?? (node !== null ? nodePos(node) : null) ?? base?.fp.center;
      if (from) pts.push({ ...from });
    }
    if (node !== null && node !== target) pts.push(...this.crewPath(node, target));
    if (site && (node !== null || !trip)) pts.push(...site.path());
    if (!pts.length) return null;
    const goal = home ? base!.fp.center : site!.pos;
    return { pts, goal: { ...goal }, home, ...(!home && b.project !== undefined ? { project: b.project } : {}) };
  }

  /** Точки пути техники от узла from до узла to: шаги crewStep (по полосам в потоке и против движения по оси). */
  private crewPath(from: number, to: number): Vec[] {
    const g = this.roads.graph;
    const key = `${from}>${to}`;
    // Граф сменился — путей заново; у выбранной базы их несколько (по бригаде), поэтому — набором.
    if (this.crewPathCache?.graph !== g || this.crewPathCache.paths.size > 64) this.crewPathCache = { graph: g, paths: new Map() };
    const hit = this.crewPathCache.paths.get(key);
    if (hit) return hit;
    const pts: Vec[] = [];
    let node = from;
    // Шагов немного (против движения — не больше двух на путь); предел — от зацикливания.
    for (let i = 0; i < 16 && node !== to; i++) {
      const step = this.crewStep(node, to);
      if (!step) break;
      if ('drive' in step) {
        const route = this.roads.route(node, step.drive);
        if (!route) break;
        pts.push(...this.roads.routePolyline(route));
        node = step.drive;
      } else {
        pts.push(...step.walk);
        node = step.node;
      }
    }
    this.crewPathCache.paths.set(key, pts);
    return pts;
  }

  /**
   * Название проекта для списков и карточек, различимое среди строек: своё или автоматическое (projectName), а если
   * у другого проекта сейчас такое же — ещё и место: ближайший город («Улица 1+1 · Заречье»); у двух таких в одном
   * городе — и сторона города стрелкой («Улица 1+1 · Заречье ↗», север — вверх); с одной стороны — ещё номер по
   * порядку закладки («Улица 1+1 · Заречье ↗ 2»).
   */
  projectTitle(id: number): string {
    const p = this.construction.projects.get(id);
    if (!p) return 'Стройка';
    const place = this.projectPlaces().get(id);
    return place ? `${projectName(p)} · ${place}` : projectName(p);
  }

  /** Место проекта id для различения одинаковых названий (projectTitle); название и так одно такое — ''. */
  projectPlace(id: number): string {
    return this.projectPlaces().get(id) ?? '';
  }

  private placeCache: { stamp: number; size: number; places: Map<number, string> } | null = null;

  /** Места проектов с одинаковыми названиями (projectTitle): город, сторона, номер. До следующего такта стройки. */
  private projectPlaces(): Map<number, string> {
    const c = this.construction;
    const hit = this.placeCache;
    if (hit && hit.stamp === c.stamp && hit.size === c.projects.size) return hit.places;
    const places = new Map<number, string>();
    const byName = new Map<string, Project[]>();
    for (const p of [...c.projects.values()].sort((a, b) => a.id - b.id)) {
      const name = projectName(p);
      const list = byName.get(name);
      if (list) list.push(p);
      else byName.set(name, [p]);
    }
    // Ближайший город (как у базы: расстояние до его края) и с какой стороны от его середины стройка — стрелкой
    // (на карте север — вверх); в самом центре города — без стрелки.
    const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
    const place = (p: Project): { town: string; side: string } => {
      const a = p.area;
      const at = a ? { x: (a[0] + a[2]) / 2, y: (a[1] + a[3]) / 2 } : (c.info(p.id)?.at ?? { x: 0, y: 0 });
      let best: Town | undefined;
      let bd = Infinity;
      for (const t of this.towns) {
        const d = dist(t.center, at) - t.radius;
        if (d < bd || (d === bd && best && t.id < best.id)) [best, bd] = [t, d];
      }
      if (!best) return { town: `№${p.id}`, side: '' };
      const off = sub(at, best.center);
      const central = Math.hypot(off.x, off.y) < best.radius * 0.25;
      const k = Math.round(Math.atan2(off.y, off.x) / (Math.PI / 4));
      return { town: best.name, side: central ? '' : ARROWS[((k % 8) + 8) % 8] };
    };
    const count = <T>(xs: T[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>());
    for (const list of byName.values()) {
      if (list.length < 2) continue;
      const named = list.map((p) => ({ p, ...place(p) }));
      const towns = count(named.map((n) => n.town));
      // Город один такой — его хватает; несколько в одном городе — ещё и сторона, а с одной стороны — номер.
      const labels = named.map((n) => (towns.get(n.town)! > 1 && n.side ? `${n.town} ${n.side}` : n.town));
      const seen = new Map<string, number>();
      const total = count(labels);
      named.forEach(({ p }, i) => {
        const k = (seen.get(labels[i]) ?? 0) + 1;
        seen.set(labels[i], k);
        places.set(p.id, total.get(labels[i])! > 1 && k > 1 ? `${labels[i]} ${k}` : labels[i]);
      });
    }
    this.placeCache = { stamp: c.stamp, size: c.projects.size, places };
    return places;
  }

  /** Бригада, чья машина не в потоке (вдоль стройки, ждёт колонну), — под точкой p: клик по ней выбирает бригаду. */
  crewAt(p: Vec, r = 6): number | undefined {
    const crews = this.construction.crews;
    for (const b of crews.brigades.values()) {
      for (const m of crews.carsAt(b)) {
        const s = CREW_CARS[Math.min(m.car, CREW_CARS.length - 1)];
        if (dist(sub(m.pos, scale(m.dir, s.length / 2)), p) <= s.length / 2 + r) return b.id;
      }
    }
    return undefined;
  }

  /** Своё название базы: пробелы по краям обрезаются; пустое — снова по ближайшему городу. */
  renameBase(id: number, name: string): void {
    const base = this.construction.crews.bases.get(id);
    if (!base) return;
    const clean = name.trim().slice(0, 40);
    if (clean === this.baseName(id)) return;
    if (clean) base.name = clean;
    else delete base.name;
    this.construction.stamp++;
  }

  isWater(p: Vec, margin = 0): boolean {
    return this.terrain.isWater(p, margin);
  }

  /**
   * Застройка у точки: дом, предприятие, станция или склад ближе CONSTRUCTION.fieldClear. Нет — чистое поле, стройка
   * там быстрее (CONSTRUCTION.field). Строительная база — не застройка: это площадка самой стройки.
   */
  builtNear(p: Vec): boolean {
    const r = CONSTRUCTION.fieldClear;
    return this.index.near(p, r).some((s) => s.type !== 'base' && pointInFootprint(p, s.fp, r));
  }

  inBounds(p: Vec, margin = 0): boolean {
    return this.terrain.inBounds(p, margin);
  }

  /** Отметка земли для профиля дорог и путей (вода — NaN); без рельефа — null. */
  ground(): ((p: Vec) => number) | null {
    const t = this.terrain;
    return t.hasRelief ? (p) => (t.isWater(p, 2) ? NaN : t.heightAt(p)) : null;
  }

  blocked(p: Vec, radius: number): boolean {
    return this.index.at(p, radius) !== null;
  }

  obstaclesAt(p: Vec, radius: number): { id: number; demolishable: boolean; gate?: number; movable?: boolean; reason?: string }[] {
    return this.index
      .near(p, radius + 60)
      .filter((s) => pointInFootprint(p, s.fp, radius))
      .map((s) => ({
        id: s.id,
        demolishable: s.type === 'building' && s.kind !== 'landmark',
        // Автостанция стоит в торце своего выезда: дороге, что входит в её узел, она не мешает.
        gate: s.type === 'station' && s.kind === 'road' ? s.nodeId : undefined,
        // Навес остановки при расширении улицы отодвигается к новому бордюру, строительная база — от новой кромки
        // (shoveStops).
        movable: (s.type === 'station' && s.kind === 'stop') || s.type === 'base',
        reason: s.type === 'base' ? 'Мешает база' : undefined,
      }));
  }

  /** Остановки у полотен corridors (в сети net) и где их навесы встанут у бордюра этой сети. */
  private stopShoves(net: LaneNet, corridors: Corridor[]): { st: Station; fp: Footprint }[] {
    const out: { st: Station; fp: Footprint }[] = [];
    for (const st of this.stations.values()) {
      const node = st.kind === 'stop' ? net.nodes.get(st.nodeId) : undefined;
      if (!node || !corridors.some((c) => c.lut.closest(st.fp.center).d < 60)) continue;
      out.push({ st, fp: curbFootprint(net, node.pos, st.fp) });
    }
    return out;
  }

  /**
   * Где встанет строительная база base, когда улицу расширили (net — сеть после правки, changed — изменённые полотна):
   * её отодвигают по перпендикуляру от своей улицы (полотна вдоль длинной стороны площадки, хотя бы одно — из changed),
   * пока до новой кромки снова не будет зазора base.gap, как при постановке (basePlan). Ворота — тот же узел, а пропал
   * он — ближний конец этой улицы. moved — площадку правда сдвинули. null — правка базу не задевает.
   */
  private baseShove(net: LaneNet, base: BuildBase, changed: Corridor[]): { fp: Footprint; nodeId: number; moved: boolean } | null {
    const B = CONSTRUCTION.base;
    const at = base.fp.center;
    const r = footprintRadius(base.fp);
    if (!changed.some((c) => c.lut.closest(at).d < r + corridorHalf(c) + B.gap + 2)) return null;
    const u = { x: Math.cos(base.fp.angle), y: Math.sin(base.fp.angle) };
    const v = { x: -u.y, y: u.x };
    // Полотна вдоль длинной стороны площадки рядом с ней; своя улица — ближайшее к площадке из изменённых.
    const along = net.corridorsNear(at, r + 40).filter((c) => {
      const hit = c.lut.closest(at);
      return Math.abs(dot(c.lut.tangentAt(hit.s), u)) > 0.95 && hit.d < corridorHalf(c) + B.gap + B.h + 6;
    });
    const gap = (c: Corridor) => {
      const hit = c.lut.closest(at);
      return hit.d - halfAtS(c, hit.s);
    };
    const own = along
      .filter((c) => changed.some((x) => x.id === c.id))
      .sort((a, b) => gap(a) - gap(b) || a.id - b.id)[0];
    if (!own) return { fp: base.fp, nodeId: base.nodeId, moved: false };
    const side = dot(sub(at, own.lut.closest(at).point), v) >= 0 ? 1 : -1;
    const away = scale(v, side);
    // Улица (и параллельные ей полотна) с той же стороны, что своя: от них и отодвигаем; дорогу позади площадки
    // не считаем — на неё база наедет, тогда «Мешает база».
    const front = along.filter((c) => dot(sub(c.lut.closest(at).point, at), away) < 0);
    let fp = base.fp;
    for (let k = 0; k < 4; k++) {
      const edge: Vec[] = [];
      for (let i = 0; i <= 8; i++) edge.push(add(fp.center, add(scale(u, (i / 8 - 0.5) * fp.w), scale(away, -fp.h / 2))));
      let need = 0;
      for (const c of front) {
        for (const q of edge) {
          const hit = c.lut.closest(q);
          need = Math.max(need, halfAtS(c, hit.s) + B.gap - hit.d);
        }
      }
      if (need < 0.05) break;
      fp = { ...fp, center: add(fp.center, scale(away, need)) };
    }
    const moved = dist(fp.center, at) >= 0.3;
    if (!moved) fp = base.fp;
    // Ворота: тот же узел, если он остался; иначе — ближний к площадке конец своей улицы.
    const nodeId = net.nodes.has(base.nodeId) ? base.nodeId : dist(net.node(own.a).pos, at) <= dist(net.node(own.b).pos, at) ? own.a : own.b;
    return { fp, nodeId, moved };
  }

  /**
   * Расширение улицы и строительные базы у изменённых полотен (сеть net после правки): каждую отодвигают от новой
   * кромки (baseShove); дома на новом месте — в demolish. Отодвинуть нельзя — за край карты, в воду, на станцию,
   * предприятие, другую базу, дорогу или путь — «Мешает база». Ответ — новые места сдвинутых баз.
   */
  private shoveBases(net: LaneNet, changed: Corridor[], demolish: Set<number>): Footprint[] | string {
    const moved: Footprint[] = [];
    for (const base of this.construction.crews.bases.values()) {
      const res = this.baseShove(net, base, changed);
      if (!res) continue;
      const fp = res.fp;
      if (this.roadUnder(fp, 1, -1, net)) return 'Мешает база';
      if (!res.moved) continue;
      if (!this.inBounds(fp.center, 40)) return 'Мешает база';
      if (footprintCorners(fp).some((q) => this.isWater(q, 2)) || this.isWater(fp.center, 2)) return 'Мешает база';
      const under = this.structuresUnder(fp, 1, base);
      if (under.blocker) return 'Мешает база';
      for (const id of under.houses) demolish.add(id);
      moved.push(fp);
    }
    return moved;
  }

  /**
   * Расширение улицы (полоса, «кармашек», перестройка): навесы остановок у изменённых полотен отодвигаются
   * к новому бордюру, строительные базы — от новой кромки (shoveBases). Дома на новом месте навеса или базы сносятся
   * (цена — в плане); другая станция, предприятие, ратуша или чужая дорога там — «Мешает здание» (у базы —
   * «Мешает база»). Ответ — новые места навесов и баз (для предпросмотра).
   */
  shoveStops(net: LaneNet, changed: Corridor[], demolish: Set<number>): Footprint[] | string {
    const bases = this.shoveBases(net, changed, demolish);
    if (typeof bases === 'string') return bases;
    const stops = this.shoveStopsOnly(net, changed, demolish);
    return typeof stops === 'string' ? stops : [...stops, ...bases];
  }

  /**
   * Полоса стоянки у домов (world/curbSqueeze.ts): что станет с домами у полотен corridors сети net — ужать участок или
   * снести. Дома — из индекса игры.
   */
  private curbSqueezes(net: LaneNet, corridors: Corridor[]): Squeeze[] {
    const ctx = { ...this.worldContext(), roads: net };
    const out: Squeeze[] = [];
    const seen = new Set<number>();
    for (const c of corridors) {
      const houses = this.index
        .near(c.lut.pointAt(c.length / 2), c.length / 2 + 80)
        .filter((s): s is TownBuilding => s.type === 'building' && s.kind !== 'landmark' && !seen.has(s.id));
      for (const x of curbSqueeze(ctx, c, houses)) {
        seen.add(x.b.id);
        out.push(x);
      }
    }
    return out;
  }

  /** План со стоянкой (RoadContext.curbSqueeze): не ужать — под снос (в цену), ответ — новые контуры ужатых домов. */
  curbSqueeze(net: LaneNet, changed: Corridor[], demolish: Set<number>): Footprint[] {
    const out: Footprint[] = [];
    for (const x of this.curbSqueezes(net, changed)) {
      if (demolish.has(x.b.id)) continue;
      if (x.fp) out.push(x.fp);
      else demolish.add(x.b.id);
    }
    return out;
  }

  /**
   * Полосу стоянки построили (план уже снёс дома, что не ужать): участки у полотен ids ужимаются — фасад отступает от
   * новой кромки, задняя граница — вглубь не дальше SQUEEZE.back. Что не ужать и план не снёс (правка не через план) —
   * сносится за счёт города.
   */
  applyCurbSqueeze(ids: number[]): void {
    const net = this.roads.net;
    const cs = ids.map((id) => net.corridors.get(id)).filter((c): c is Corridor => !!c && c.lanes.some((l) => l.park));
    if (!cs.length) return;
    const razed: number[] = [];
    for (const x of this.curbSqueezes(net, cs)) {
      if (!x.fp) {
        razed.push(x.b.id);
        continue;
      }
      this.index.remove(x.b);
      x.b.fp = x.fp;
      this.index.add(x.b);
      this.townRev++;
    }
    if (razed.length) this.demolish(razed);
    for (const c of cs) this.refreshCatchmentsNear(c.lut.pointAt(c.length / 2));
  }

  /** Навесы остановок у изменённых полотен — к новому бордюру (shoveStops). */
  private shoveStopsOnly(net: LaneNet, changed: Corridor[], demolish: Set<number>): Footprint[] | string {
    const moved: Footprint[] = [];
    for (const { st, fp } of this.stopShoves(net, changed)) {
      const node = net.node(st.nodeId).pos;
      const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
      const v = { x: -u.y, y: u.x };
      // Чужая дорога по навесу (на старом месте или новом): своя улица навес обходит по построению.
      const probes: Vec[] = [];
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 2; j++) probes.push(add(fp.center, add(scale(u, (i / 4 - 0.5) * fp.w), scale(v, (j / 2 - 0.5) * fp.h))));
      for (const c of net.corridorsNear(fp.center, footprintRadius(fp) + 40)) {
        if (isStopStreet(c, node, st.fp)) continue;
        if (probes.some((q) => c.lut.closest(q).d < halfAtS(c, c.lut.closest(q).s))) return 'Мешает здание';
      }
      if (dist(fp.center, st.fp.center) < 0.3) continue;
      for (const s of this.index.near(fp.center, footprintRadius(fp) + 120)) {
        if (s === st || !footprintsOverlap(fp, s.fp, 1)) continue;
        if (s.type === 'building' && s.kind !== 'landmark') demolish.add(s.id);
        else return s.type === 'base' ? 'Мешает база' : 'Мешает здание';
      }
      moved.push(fp);
    }
    return moved;
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
      this.townRev++;
      touched.add(town);
      this.refreshCatchmentsNear(b.fp.center);
    }
    for (const t of touched) recountPopulation(t);
    // Снесли магазин-получатель — город подбирает другой (кроме стоящих в маршрутах: их станция покажет «не подъехать»).
    for (const t of touched) if (t.receivers?.some((r) => ids.includes(r.b))) this.refreshReceivers(t);
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
      refund += corridorCost(this.roads.net, c, (q, m) => this.isWater(q, m), this.ground()) * share * COST.refundRatio;
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

  /** Перенос здания: цена (60 % сноса, у ратуши — и перенос её площади) и площадь у ратуши, что едет вместе с ней. */
  buildingMove(b: TownBuilding): { cost: number; plaza: TownPark | null } {
    const town = this.townOf(b);
    const plaza = b.kind === 'landmark' && town ? hallPlaza(town, b.fp) : null;
    return { cost: (Math.round(this.demolishCost(b.id) * 0.6) || 3000) + (plaza ? parkMoveCost(plaza) : 0), plaza };
  }

  /**
   * Куда встанет здание при переносе: вдоль ближайшей улицы, участок — в MOVE_SETBACK от фактического края асфальта,
   * как дома улиц при застройке (fillStreet), а площадь вокруг ратуши и храма (townForms.yardOf) — ещё дальше на свою
   * ширину: не на тротуаре и не на полотне, ни у этой улицы, ни у соседних, ни на площадке перекрёстка
   * (lotClearOfRoads). Ратуша — вместе со своей площадью (townParks.hallPlaza): с той же стороны фасада; там тесно
   * или площадь осталась на старом месте после прежнего переноса — у той стороны, где шире (plazaBy); места нет и
   * так — отказ. plaza — куда встанет площадь; lot — участок с площадью вокруг здания (для подсветки).
   *
   * turn — поворот ратуши и храма от улицы (world/moveTurn.ts, R и ручка ↺): участок с площадью вокруг поворачивается
   * вокруг середины и отступает от улицы так, чтобы ближний угол остался в MOVE_SETBACK от асфальта; фасад — куда
   * повернули (face = −1, угол рисунка — в fp.angle). base — угол рисунка без поворота у этой улицы. Дома не
   * поворачиваются (turnableBuilding).
   */
  movePlan(
    b: TownBuilding,
    p: Vec,
    turn = 0,
  ): {
    ok: boolean;
    reason?: string;
    fp: Footprint | null;
    cost: number;
    anchor: number;
    face?: 1 | -1;
    lot?: Footprint;
    plaza?: { park: TownPark; fp: Footprint };
    base?: number;
    turn: number;
  } {
    const town = this.townOf(b);
    const { cost, plaza: own } = this.buildingMove(b);
    const yard = yardOf(b);
    const turns = turnableBuilding(b);
    const tn = turns ? wrapTurn(turn) : 0;
    const reach = turns ? turnReach(b.fp.w + yard * 2, b.fp.h + yard * 2, tn) : yard + b.fp.h / 2;
    // Улица — ближе 60 м и площади (повёрнутая ратуша середкой дальше от улицы — и искать дальше).
    const hit = this.streetNear(p, Math.max(60 + yard, MOVE_SETBACK + reach + 30));
    if (!hit) return { ok: false, reason: 'Поставьте рядом с улицей', fp: null, cost, anchor: 0, turn: tn };
    const seg = hit.seg;
    const net = this.roads.net;
    const n = normalTowards(seg, hit.s, p);
    const t = seg.lut.tangentAt(hit.s);
    const base = streetBase(n);
    const center = add(seg.lut.pointAt(hit.s), scale(n, halfAtS(seg, hit.s) + MOVE_SETBACK + reach));
    const fp: Footprint = { center, w: b.fp.w, h: b.fp.h, angle: turns ? wrapTurn(base + tn) : Math.atan2(t.y, t.x) };
    const lot: Footprint = { ...fp, w: fp.w + yard * 2, h: fp.h + yard * 2 };
    // Ратуша и храм — угол рисунка прямо в fp.angle (фасад — к −y): поворот любой, а не только «лицом к улице».
    const face = turns ? -1 : streetFace(net, fp);
    const anchor = anchorFor(net, center);
    const fail = (reason: string) => ({ ok: false, reason, fp, cost, anchor, face, lot, base, turn: tn });
    this.index.remove(b);
    try {
      if (!placeable(this.worldContext(), lot, seg.id)) return fail('Здесь мало места');
      if (!lotClearOfRoads(net, lot, WALK_EDGE)) return fail('Мешает дорога');
      if (this.parkUnder(lot, own)) return fail('Мешает парк');
      let plaza: { park: TownPark; fp: Footprint } | undefined;
      if (own && town) {
        const others = (town.parks ?? []).filter((k) => k !== own);
        const site = parkSite(this.worldContext());
        // Площадь — как перенесённый парк: не на дороге с тротуаром, не на домах и других парках, не в воде.
        const fits = (f: Footprint, shore?: boolean) => site.fits(f, shore) && lotClearOfRoads(net, f, WALK_EDGE) && !this.parkUnder(f, own);
        const drawn = (f: Footprint, side: number) => (side === 1 ? f.angle + Math.PI : f.angle);
        const same = plazaAttached(b.fp, own.fp) ? carryFootprint(own.fp, b.fp, drawn(b.fp, b.face ?? -1), fp, drawn(fp, face)) : null;
        const to = same && fits(same) ? same : plazaBy(fp, { ...site, fits }, others);
        if (!to) return fail('Площади у ратуши мало места');
        plaza = { park: own, fp: to };
      }
      if (cost > this.budget) return fail('Не хватает денег');
      return { ok: true, fp, cost, anchor, face, lot, plaza, base, turn: tn };
    } finally {
      this.index.add(b);
    }
  }

  /** Переносит здание (movePlan; turn — поворот ратуши и храма от улицы). false — нельзя. */
  moveBuilding(b: TownBuilding, p: Vec, turn = 0): boolean {
    const plan = this.movePlan(b, p, turn);
    if (!plan.ok || !plan.fp) return false;
    const from = b.fp.center;
    this.index.remove(b);
    b.fp = plan.fp;
    b.anchor = plan.anchor;
    b.face = plan.face ?? streetFace(this.roads.net, b.fp);
    if (plan.turn) b.turn = plan.turn;
    else delete b.turn;
    this.index.add(b);
    const town = this.townOf(b);
    // Площадь у ратуши — следом: тот же парк (раскладка дорожек, деревьев и клумб — его же), на новом месте.
    if (plan.plaza && town) {
      plan.plaza.park.fp = plan.plaza.fp;
      // Повернулась вместе с ратушей — свой прежний поворот от улицы уже не тот.
      delete plan.plaza.park.turn;
    }
    // Новый список — карта перерисует дома и парки города (renderer: по ссылке на список), выбор парков — тоже.
    if (town) {
      town.buildings = [...town.buildings];
      if (town.parks) town.parks = [...town.parks];
    }
    this.layoutRev++;
    this.townRev++;
    this.spend(plan.cost);
    this.refreshCatchmentsNear(from);
    this.refreshCatchmentsNear(b.fp.center);
    return true;
  }

  /** Участок f задевает парк какого-нибудь города (кроме skip): с запасом 2 м. */
  private parkUnder(f: Footprint, skip: TownPark | null): boolean {
    const r = footprintRadius(f);
    for (const t of this.towns) {
      if (dist(t.center, f.center) > (t.extent ?? t.radius) + r + 400) continue;
      for (const k of t.parks ?? []) {
        if (k === skip || dist(k.fp.center, f.center) > r + footprintRadius(k.fp) + 2) continue;
        if (footprintsOverlap(f, k.fp, 2)) return true;
      }
    }
    return false;
  }

  /**
   * Куда встанет парк, сквер, площадь или сквер с памятником при переносе («Перенести» в карточке парка): у улицы
   * (ближний край — не дальше половины глубины и 30 м от неё) — вдоль неё, ближней длинной стороной за тротуаром
   * (WALK_EDGE + 1 м от края асфальта), как перенесённый дом; дальше от улиц — серединой под курсор, с прежним
   * поворотом. Не на дорогу и тротуар, не на дома, станции и предприятия, не на площадь у ратуши, не на другой парк,
   * не в воду. Деревья, дорожки, фонтан — его же (раскладка — по id и размеру парка, parkArt), едут вместе с ним.
   *
   * turn — поворот от улицы (world/moveTurn.ts, R и ручка ↺): участок поворачивается вокруг середины и отступает так,
   * чтобы ближний к улице угол остался за тротуаром; вдали от улиц — от прежнего угла без его поворота (TownPark.turn).
   * base — угол без поворота на этом месте. Проверки — те же, по повёрнутому участку.
   */
  parkMovePlan(id: number, p: Vec, turn = 0): { ok: boolean; reason?: string; fp: Footprint | null; cost: number; base?: number; turn: number } {
    const tn = wrapTurn(turn);
    const hit = this.parkById(id);
    if (!hit || !movablePark(hit.park)) return { ok: false, reason: 'Это не перенести', fp: null, cost: 0, turn: tn };
    const park = hit.park;
    const cost = parkMoveCost(park);
    const net = this.roads.net;
    const reach = turnReach(park.fp.w, park.fp.h, tn);
    const street = this.streetNear(p, reach + 30);
    let fp: Footprint;
    let base: number;
    if (street) {
      const n = normalTowards(street.seg, street.s, p);
      base = streetBase(n);
      const center = add(street.seg.lut.pointAt(street.s), scale(n, halfAtS(street.seg, street.s) + WALK_EDGE + 1 + reach));
      fp = { center, w: park.fp.w, h: park.fp.h, angle: wrapTurn(base + tn) };
    } else {
      base = wrapTurn(park.fp.angle - (park.turn ?? 0));
      fp = { ...park.fp, center: { ...p }, angle: wrapTurn(base + tn) };
    }
    const fail = (reason: string) => ({ ok: false, reason, fp, cost, base, turn: tn });
    if (!this.inBounds(fp.center, 30)) return fail('За краем карты');
    // Вода — по сетке через 8 м и по контуру: озерцо посреди парка тоже в счёт.
    const wet = lotOutline(fp, 6).some((q) => this.isWater(q, 1)) || lotGrid(fp, 8).some((q) => this.isWater(q, 1));
    if (wet) return fail('Мешает вода');
    if (!lotClearOfRoads(net, fp, WALK_EDGE)) return fail('Мешает дорога');
    if (onRail(this.net, fp, 4)) return fail('Мешает железная дорога');
    // Площадь вокруг ратуши и храма — тоже их (сама площадь у ратуши с ней сливается: ей можно вплотную к зданию).
    const under = this.index
      .near(fp.center, footprintRadius(fp) + 200)
      .find((s) => footprintsOverlap(fp, s.fp, 3 + (s.type === 'building' && park.kind !== 'plaza' ? yardOf(s) : 0)));
    if (under) return fail(under.type === 'building' ? 'Мешают дома' : 'Здесь занято');
    if (this.parkUnder(fp, park)) return fail('Мешает другой парк');
    if (cost > this.budget) return fail('Не хватает денег');
    return { ok: true, fp, cost, base, turn: tn };
  }

  /** Переносит парк (parkMovePlan; turn — поворот от улицы): участок — на новое место, раскладка внутри — та же. false — нельзя. */
  movePark(id: number, p: Vec, turn = 0): boolean {
    const plan = this.parkMovePlan(id, p, turn);
    const hit = this.parkById(id);
    if (!plan.ok || !plan.fp || !hit) return false;
    hit.park.fp = plan.fp;
    hit.park.moved = true;
    if (plan.turn) hit.park.turn = plan.turn;
    else delete hit.park.turn;
    // Новый список — карта перерисует парки города, выбор мышью пересоберёт сетку (ParkIndex — по ссылке на список).
    hit.town.parks = [...(hit.town.parks ?? [])];
    this.layoutRev++;
    this.townRev++;
    this.spend(plan.cost);
    return true;
  }

  // ---------- Площадки-стоянки (docs/PARKING.md, этап 3; раскладка — world/parkingLots.ts) ----------

  /** Площадка по id и её город (снесённой — нет). */
  lotById(id: number): LotRef | undefined {
    return this.lots.get(id);
  }

  /** Площадка под точкой. */
  lotAt(p: Vec): LotRef | null {
    for (const x of this.lots.all()) if (pointInFootprint(p, x.lot.fp, 0.5)) return x;
    return null;
  }

  /** Участок f задевает площадку (кроме skip), с запасом margin: дома, станции, другие площадки сюда не встают. */
  lotUnder(f: Footprint, margin = 1, skip?: number): boolean {
    const r = footprintRadius(f);
    return this.lots.all().some((x) => x.lot.id !== skip && dist(x.lot.fp.center, f.center) < r + footprintRadius(x.lot.fp) + margin && footprintsOverlap(f, x.lot.fp, margin));
  }

  /** Город площадки в точке p: ближний, в чьей черте (с запасом) точка; нет такого — ближний вообще. */
  private lotTown(p: Vec): Town | undefined {
    let best: Town | undefined;
    let bestD = Infinity;
    for (const t of this.towns) {
      const d = dist(t.center, p) - (t.extent ?? t.radius);
      if (d < bestD) [best, bestD] = [t, d];
    }
    return best;
  }

  /** Полотна тупиков-выездов большой площадки (у узлов ворот). */
  private lotStubs(lot: Pick<ParkingLot, 'nodes'>): number[] {
    const ids = new Set<number>();
    for (const n of lot.nodes ?? []) for (const id of this.roads.net.nodes.get(n)?.corridors ?? []) ids.add(id);
    return [...ids];
  }

  /**
   * Ворота на шаге сетки, внутри ширины, не друг на друге (у большой — не ближе LOT.corner + ширины ворот; тупик-выезд с
   * кромкой — весь на площадке, не у её бокового края).
   */
  private fitGates(w: number, gates: readonly LotGate[], big: boolean): LotGate[] {
    const out: LotGate[] = [];
    const lim = w / 2 - (big ? LOT.stubEdge + 1 : LOT.gateW / 2);
    const gap = big ? LOT.corner + LOT.gateW : LOT.gateW;
    for (const g of gates) {
      let x = snapGate(w, Math.max(-lim, Math.min(lim, g.x)));
      if (Math.abs(x) > lim + 0.01) x -= Math.sign(x) * LOT.stall.w;
      if (out.some((o) => Math.abs(o.x - x) < gap - 0.01)) continue;
      out.push({ x, mode: g.mode });
    }
    return out.length ? out : defaultGates(w);
  }

  /**
   * Где встанет площадка cols × rows у курсора p («🅿️ Площадка» в «Станции»): у улицы — вдоль неё, краем за тротуаром
   * (LOT.setback от края полотна), как перенос парка; free (Alt) или вдали от улиц — серединой под курсор, с поворотом
   * angle. gates — ворота (перенос: те же, по оси участка), нет — одни посередине. skip — переносим эту площадку.
   */
  lotPlan(p: Vec, shape: LotShape, skip?: number): LotPlan {
    const cols = Math.max(LOT.cols.min, Math.min(LOT.cols.max, Math.round(shape.cols)));
    const W = lotWidth(cols);
    const H = lotDepth(shape.rows);
    const street = shape.free ? null : this.streetNear(p, H / 2 + 30);
    let fp: Footprint;
    if (street) {
      const n = normalTowards(street.seg, street.s, p);
      const center = add(street.seg.lut.pointAt(street.s), scale(n, halfAtS(street.seg, street.s) + LOT.setback + H / 2));
      fp = { center, w: W, h: H, angle: lotAngle(n) };
    } else fp = { center: { ...p }, w: W, h: H, angle: shape.angle ?? 0 };
    return this.lotCheck(fp, shape.gates ?? defaultGates(W), skip, skip !== undefined ? 'move' : 'place');
  }

  /**
   * Площадка с участком fp и воротами gates — можно ли и почём: не за краем, не в воде, не на дороге, путях, станции,
   * предприятии, парке и другой площадке; дома под ней — под снос (цена — в плане). Ворота — к улице (не магистраль),
   * не ближе LOT.corner к перекрёстку, хотя бы одни — с въездом и с выездом. Больше LOT.big мест — у ворот тупики-выезды
   * (план дороги roads; старые тупики переносимой — прочь). skip — правим эту площадку: mode — перенос (новая минус
   * возврат части прежней) или правка размера и ворот (разница: больше — доплата, меньше — возврат части).
   */
  lotCheck(fp: Footprint, gatesIn: readonly LotGate[], skip?: number, mode: 'place' | 'move' | 'edit' = 'place', owner: ParkingLot['owner'] = 'player'): LotPlan {
    const ref = skip !== undefined ? this.lots.get(skip) : undefined;
    const old = ref?.lot;
    const W = fp.w;
    const big0 = lotIsBig({ fp, gates: gatesIn.length ? [gatesIn[0]] : defaultGates(W) });
    const gates = this.fitGates(W, gatesIn, big0);
    const shape = { id: skip ?? -1, fp, gates };
    const stalls = lotStallCount(shape);
    const big = lotIsBig(shape);
    const town = ref?.town ?? this.lotTown(fp.center);
    const paid = (old?.owner ?? owner) === 'player';
    const price = paid ? lotCost(shape) : 0;
    const was = old && paid ? lotCost(old) : 0;
    const base = { fp, gates, stalls, big, demolish: [] as number[], town, spend: 0, back: 0 };
    const fail = (reason: string, extra: Partial<LotPlan> = {}): LotPlan => ({ ...base, ok: false, reason, cost: price, ...extra });
    if (!town) return fail('Поставьте у города');
    if (!this.inBounds(fp.center, 30)) return fail('За краем карты');
    if (lotOutline(fp, 6).some((q) => this.isWater(q, 1)) || lotGrid(fp, 8).some((q) => this.isWater(q, 1))) return fail('Мешает вода');
    if (onRail(this.net, fp, 2)) return fail('Мешает железная дорога');
    const own = new Set(old?.nodes ?? []);
    const road = this.roadUnder(fp, 1, own);
    if (road) return fail(road);
    const under = this.structuresUnder(fp, 1, undefined, false);
    if (under.blocker) return fail(under.blocker);
    if (this.parkUnder(fp, null)) return fail('Мешает парк');
    if (this.lotUnder(fp, 1, skip)) return fail('Мешает другая площадка');
    if (!gates.some((g) => gateOut(g.mode))) return fail('Нужны ворота с выездом');
    if (!gates.some((g) => gateIn(g.mode))) return fail('Нужны ворота с въездом');
    // Ворота — к улице, не у перекрёстка; маленькой — чтобы с полосы можно было свернуть в них (как во двор).
    const net = this.roads.net;
    const g0 = this.roads.graph;
    const L = CAR_SPEC.length;
    const bad: number[] = [];
    gates.forEach((g, i) => {
      const d = lotGateDriveway(shape, g);
      const at = drivewayLink(net, d);
      const c = at && net.corridors.get(at.corridor);
      if (!at || !c || c.ring || isTrunk(c.cls) || net.node(c.a).level !== 0 || net.node(c.b).level !== 0) return void bad.push(i);
      const [ca, cb] = g0.cutOf(c.id) ?? [0, 0];
      const junction = (id: number) => (net.nodes.get(id)?.corridors.length ?? 0) >= 3;
      if ((junction(c.a) && at.s - ca < LOT.corner) || (junction(c.b) && c.length - cb - at.s < LOT.corner)) return void bad.push(i);
      if (!big && !laneSlot(g0, net, d, add(d.curb, scale(d.dir, L / 2 + 0.3)), L, CAR_SPEC.width)) bad.push(i);
    });
    if (bad.length) return fail(bad.length === gates.length ? 'Ворота — к улице, не ближе 10 м к перекрёстку' : 'Эти ворота не к улице или у перекрёстка', { badGates: bad });
    // Тупики-выезды большой площадки (и снос прежних); дома под ними сносит строитель — их цена в плане дороги.
    let roads: RoadPlan | undefined;
    const nodes: Vec[] = big ? gates.map((g) => lotGateNode(shape, g).node) : [];
    const stubs = old ? this.lotStubs(old) : [];
    if (big || stubs.length) {
      roads = this.roadBuilder.plan((n) => {
        for (const id of stubs) if (n.corridors.has(id)) bulldoze(n, id);
        for (const g of big ? gates : []) {
          const at = drivewayLink(n, lotGateDriveway(shape, g));
          const c = at && n.corridors.get(at.corridor);
          if (!at || !c) return false;
          buildRoad(n, { kind: 'corridor', corridor: c.id, s: at.s, pos: c.lut.pointAt(at.s) }, { kind: 'free', pos: lotGateNode(shape, g).node }, DRIVEWAY);
        }
        return true;
      });
      if (!roads.ok) return fail(roads.reason ?? 'Тупик к воротам не построить', { roads });
    }
    const demolish = under.houses.filter((id) => !roads?.demolish.includes(id));
    const razed = this.demolishTotal(demolish);
    // Деньги за саму площадку: новая; перенос — минус возврат части прежней; правка — разница.
    let spend = price;
    let back = 0;
    if (old && mode === 'move') back = Math.round(was * COST.refundRatio);
    if (old && mode === 'edit') {
      spend = Math.max(0, price - was);
      back = Math.round(Math.max(0, was - price) * COST.refundRatio);
    }
    const cost = spend - back + razed + (roads?.cost ?? 0);
    const plan: LotPlan = { ...base, ok: true, cost, demolish, roads, nodes, spend, back };
    if (paid && cost > this.budget && cost > 0) return { ...plan, ok: false, reason: 'Не хватает денег' };
    return plan;
  }

  /** Ставит площадку игрока (lotPlan); поставили — она, нельзя — причина. */
  placeLot(p: Vec, shape: LotShape): ParkingLot | string {
    const plan = this.lotPlan(p, shape);
    if (!plan.ok || !plan.town) return plan.reason ?? 'Нельзя поставить';
    const lot: ParkingLot = { id: this.nextEntityId++, fp: plan.fp, gates: plan.gates, owner: 'player', tariff: 0 };
    return this.applyLot(plan, lot, true) ? lot : 'Нельзя поставить';
  }

  /** План по месту: дороги (тупики), снос, деньги, участок и ворота — площадке lot (новой — в город плана). */
  private applyLot(plan: LotPlan, lot: ParkingLot, add: boolean): boolean {
    if (!plan.ok || !plan.town) return false;
    if (plan.roads) {
      for (const pos of plan.nodes ?? []) if (plan.roads.net) keepMainRoad(plan.roads.net, pos);
      if (!this.roadBuilder.apply(plan.roads)) return false;
    }
    if (plan.demolish.length) {
      const cost = this.demolishTotal(plan.demolish);
      this.demolish(plan.demolish);
      this.spend(cost);
    }
    if (plan.spend) this.spend(plan.spend);
    if (plan.back) {
      this.money += plan.back;
      this.incomeMonth += plan.back;
      this.ledger.sales += plan.back;
    }
    lot.fp = plan.fp;
    lot.gates = plan.gates;
    // Узлы ворот — открытые концы сети (тупик-выезд без разворота: дальше проезд площадки): прежние — снять, новые — поставить.
    for (const id of lot.nodes ?? []) this.roads.net.setOpen(id, false);
    if (plan.big && plan.nodes?.length) lot.nodes = plan.nodes.map((p) => this.roads.net.nodesNear(p, 2)[0]?.id ?? -1);
    else delete lot.nodes;
    for (const id of lot.nodes ?? []) this.roads.net.setOpen(id, true);
    if (add) plan.town.lots = [...(plan.town.lots ?? []), lot];
    else plan.town.lots = [...(plan.town.lots ?? [])];
    this.lotRev++;
    this.layoutRev++;
    return true;
  }

  /** Перенос площадки к курсору (ворота — те же по оси участка; free — Alt, angle — поворот). */
  lotMovePlan(id: number, p: Vec, free = false, angle?: number): LotPlan | null {
    const ref = this.lots.get(id);
    if (!ref) return null;
    const { lot } = ref;
    return this.lotPlan(p, { cols: Math.round((lot.fp.w - LOT.aisle) / LOT.stall.w), rows: lotRows(lot.fp.h), gates: lot.gates, free, angle: angle ?? lot.fp.angle }, id);
  }

  /**
   * Новый размер площадки (ручка угла): cols × rows, край у улицы — на месте, двигается край side (−1 — левый, 1 —
   * правый по оси участка); ворота — там же на улице.
   */
  lotResizePlan(id: number, cols: number, rows: LotRows, side: -1 | 1): LotPlan | null {
    const ref = this.lots.get(id);
    if (!ref) return null;
    const { lot } = ref;
    const W = lotWidth(Math.max(LOT.cols.min, Math.min(LOT.cols.max, cols)));
    const H = lotDepth(rows);
    const dx = (side * (W - lot.fp.w)) / 2;
    const dy = (H - lot.fp.h) / 2;
    const c = Math.cos(lot.fp.angle);
    const s = Math.sin(lot.fp.angle);
    const center = { x: lot.fp.center.x + dx * c - dy * s, y: lot.fp.center.y + dx * s + dy * c };
    const gates = lot.gates.map((g) => ({ ...g, x: g.x - dx }));
    return this.lotCheck({ center, w: W, h: H, angle: lot.fp.angle }, gates, id, 'edit');
  }

  /** Площадка с поворотом angle вокруг середины (ручка поворота, шаг LOT.turn). */
  lotRotatePlan(id: number, angle: number): LotPlan | null {
    const ref = this.lots.get(id);
    if (!ref) return null;
    const a = Math.round(angle / LOT.turn) * LOT.turn;
    return this.lotCheck({ ...ref.lot.fp, angle: a }, ref.lot.gates, id, 'edit');
  }

  /** Правка площадки по плану (перенос, размер, поворот, ворота) — одним шагом Ctrl+Z; нельзя — причина. */
  editLot(id: number, plan: LotPlan | null, label: string): string | null {
    const ref = this.lots.get(id);
    if (!ref || !plan) return 'Площадки нет';
    if (!plan.ok) return plan.reason ?? 'Нельзя';
    this.checkpoint(label);
    const ok = this.applyLot(plan, ref.lot, false);
    this.commit();
    return ok ? null : 'Нельзя';
  }

  /**
   * Клик по краю площадки у дороги (ворота): по воротам — ⬌ → въезд → выезд → убрать (если остаются и въезд, и выезд);
   * мимо ворот — новые ворота ⬌ на шаге сетки. Нельзя — причина.
   */
  toggleLotGate(id: number, p: Vec): string | null {
    const ref = this.lots.get(id);
    if (!ref) return 'Площадки нет';
    const { lot } = ref;
    const q = lotLocal(lot.fp, p);
    const i = lot.gates.findIndex((g) => Math.abs(g.x - q.x) < LOT.gateW / 2 + 0.5);
    const order: LotGate['mode'][] = ['both', 'in', 'out'];
    const tries: LotGate[][] = [];
    if (i < 0) tries.push([...lot.gates, { x: snapGate(lot.fp.w, q.x), mode: 'both' }]);
    else {
      // Следующий режим, потом — убрать; что не годится (не останется въезда или выезда) — пропускаем.
      const k = order.indexOf(lot.gates[i].mode);
      for (let s = 1; s <= 3; s++) {
        const next = k + s;
        if (next < order.length) tries.push(lot.gates.map((g, j) => (j === i ? { ...g, mode: order[next] } : g)));
        else if (next === order.length && lot.gates.length > 1) tries.push(lot.gates.filter((_, j) => j !== i));
        else if (next > order.length) tries.push(lot.gates.map((g, j) => (j === i ? { ...g, mode: order[next - order.length - 1] } : g)));
      }
    }
    let reason = 'Нельзя';
    for (const gates of tries) {
      if (!gates.some((g) => gateIn(g.mode)) || !gates.some((g) => gateOut(g.mode))) continue;
      const plan = this.lotCheck(lot.fp, gates, id, 'edit');
      if (plan.ok) return this.editLot(id, plan, 'ворота площадки');
      reason = plan.reason ?? reason;
    }
    return i >= 0 && lot.gates.length === 1 ? 'Одни ворота — в обе стороны: добавьте ещё, кликнув по краю у улицы' : reason;
  }

  /** Сносит площадку: тупики-выезды прочь, возврат части цены (у города — бесплатно); стоявшие машины — «в разъездах». */
  removeLot(id: number): boolean {
    const ref = this.lots.get(id);
    if (!ref) return false;
    const { lot, town } = ref;
    this.checkpoint('снос площадки');
    const stubs = this.lotStubs(lot);
    if (stubs.length) {
      const plan = this.roadBuilder.bulldoze(stubs);
      if (plan.net) this.roadBuilder.apply({ ...plan, ok: true });
    }
    if (lot.owner === 'player') this.refund(lotCost(lot));
    lot.removed = true;
    for (const id of lot.nodes ?? []) this.roads.net.setOpen(id, false);
    delete lot.nodes;
    town.lots = [...(town.lots ?? [])];
    this.lotRev++;
    this.layoutRev++;
    this.commit();
    return true;
  }

  /** Содержание площадок игрока, $ в месяц (LOT.upkeep цены). */
  private lotsUpkeep(): number {
    let sum = 0;
    for (const { lot } of this.lots.all()) if (lot.owner === 'player') sum += lotUpkeep(lot);
    return sum;
  }

  /**
   * Город ставит площадку сам (WorldSettings.parking, без сноса и без генератора случайных чисел): у рынка и ратуши —
   * на 12–20 мест, если рядом есть место; у станции, где рядом нет мест (ни полос стоянки, ни площадок), — на 12
   * (подготовка к P+R). Одна за раз на город; at — места у этой точки, skip — участок, рядом с которым ставить.
   */
  townLots(town: Town): boolean {
    if (!parkingOn(this.settings)) return false;
    const lots = (town.lots ?? []).filter((l) => !l.removed);
    for (const b of town.buildings) {
      const form = formOf(b);
      if (form !== 'market' && b.kind !== 'landmark') continue;
      if (lots.some((l) => l.for === b.id)) continue;
      const plan = this.autoLotPlan(town, b.fp, [10, 8, 6]);
      if (plan) return this.addTownLot(plan, { for: b.id });
    }
    for (const st of this.stations.values()) {
      if (st.kind === 'dock' || !this.ownedBy(town, st.fp.center) || dist(st.fp.center, town.center) > (town.extent ?? town.radius) + 150) continue;
      if (lots.some((l) => l.station === st.id)) continue;
      if (this.curb.near(st.fp.center, CURB_TRIPS.destRange).length || this.lots.near(st.fp.center, LOT.near / 2).length) continue;
      const plan = this.autoLotPlan(town, st.fp, [6]);
      if (plan) return this.addTownLot(plan, { station: st.id });
    }
    return false;
  }

  /** Площадка города у участка near: у ближних улиц, по возрастанию расстояния, первая, что встаёт без сноса. */
  private autoLotPlan(town: Town, near: Footprint, sizes: number[]): LotPlan | null {
    const net = this.roads.net;
    const H = lotDepth(2);
    const reach = footprintRadius(near) + 90;
    for (const cols of sizes) {
      const W = lotWidth(cols);
      const cands: { fp: Footprint; d: number }[] = [];
      for (const c of net.corridorsNear(near.center, reach + 40)) {
        if (c.ring || c.build || isTrunk(c.cls) || net.node(c.a).level !== 0 || net.node(c.b).level !== 0) continue;
        for (let s = LOT.corner + W / 2; s <= c.length - LOT.corner - W / 2; s += 6) {
          const pt = c.lut.pointAt(s);
          const t = c.lut.tangentAt(s);
          for (const side of [1, -1]) {
            const n = { x: -t.y * side, y: t.x * side };
            const center = add(pt, scale(n, halfAtS(c, s) + LOT.setback + H / 2));
            const d = dist(center, near.center);
            if (d > reach + W / 2) continue;
            cands.push({ fp: { center, w: W, h: H, angle: lotAngle(n) }, d });
          }
        }
      }
      cands.sort((a, b) => a.d - b.d || a.fp.center.x - b.fp.center.x || a.fp.center.y - b.fp.center.y);
      for (const x of cands) {
        if (footprintsOverlap(x.fp, near, 2)) continue;
        const plan = this.lotCheck(x.fp, defaultGates(W), undefined, 'place', 'town');
        if (plan.ok && !plan.demolish.length && !plan.roads && plan.town === town) return plan;
      }
    }
    return null;
  }

  private addTownLot(plan: LotPlan, extra: Pick<ParkingLot, 'for' | 'station'>): boolean {
    const lot: ParkingLot = { id: this.nextEntityId++, fp: plan.fp, gates: plan.gates, owner: 'town', tariff: 0, ...extra };
    return this.applyLot(plan, lot, true);
  }

  /** Конец месяца: счёт площадок — в прошлый месяц, снесённые — прочь; отказы клеток — заново. */
  private closeLots(): void {
    for (const t of this.towns) {
      delete t.parkRefused;
      if (!t.lots?.length) continue;
      const live = t.lots.filter((l) => !l.removed);
      for (const l of live) {
        l.last = l.month ?? emptyStats();
        delete l.month;
      }
      if (live.length !== t.lots.length) {
        t.lots = live;
        this.lotRev++;
      }
    }
  }

  refreshCatchmentsNear(p: Vec): void {
    for (const st of this.stations.values()) {
      if (dist(st.fp.center, p) < this.catchmentRadius(st) + 60) this.computeCatchment(st);
    }
  }

  /** Новый номер сущности партии (предприятие, пристройка, база…): тот же счётчик, что пишется в сохранение. */
  nextId(): number {
    return this.nextEntityId++;
  }

  /** Расход: стройка (по умолчанию) или покупка транспорта — для отчёта о финансах. */
  spend(amount: number, kind: 'build' | 'purchases' = 'build'): void {
    const a = Math.round(amount);
    const before = this.money;
    this.money -= a;
    this.expensesMonth += a;
    this.ledger[kind] += a;
    if (a > 0) this.warnUpkeep(before);
  }

  /**
   * Разовые покупки игрока (машина, станция, дорога «Мгновенно», бригада) ограничены только кредитным пределом
   * (budget): купить можно и из запаса на содержание, но осознанно — трата, после которой на счёте меньше кредитного
   * предела + запаса на содержание (upkeepReserve: что спишется за полмесяца), предупреждает: сколько уходит в месяц
   * и через сколько без выручки счёт уйдёт за предел (upkeepRunway). Только при переходе черты, чтобы не повторять на
   * каждой покупке ниже неё. Автоматическая стройка (buildBudget) эту черту не переходит.
   */
  private warnUpkeep(before: number): void {
    const line = ECONOMY.creditLimit + this.upkeepReserve;
    if (before < line || this.money >= line) return;
    const runway = this.upkeepRunway;
    this.notify(
      `💸 Взято из запаса на содержание: оно идёт ${usd(this.upkeepForecast().total)} в месяц — ${runway >= 1 ? `через ${durationText(runway)}` : 'сразу'} без выручки на счёте станет меньше −${usd(-ECONOMY.creditLimit)} (банкротство)`,
      '#e5a33b',
      { kind: 'money' },
    );
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
  roadWidened(segId: number, houses = true): void {
    const seg = this.roads.net.corridors.get(segId);
    if (!seg) return;
    // Остановки — к новому бордюру (сначала они: дома потом отодвигаются, не налезая на навес).
    // Дома на новом месте навеса план уже снёс; если правка шла не через план — сносим за счёт города.
    for (const { st, fp } of this.stopShoves(this.roads.net, [seg])) {
      if (dist(fp.center, st.fp.center) < 0.3) continue;
      this.index.remove(st);
      st.fp = fp;
      this.stationRev++;
      this.index.add(st);
      const under = this.index.near(fp.center, footprintRadius(fp) + 120).filter((s) => s !== st && s.type === 'building' && s.kind !== 'landmark' && footprintsOverlap(fp, s.fp, 1));
      if (under.length) this.demolish(under.map((s) => s.id));
      this.computeCatchment(st);
    }
    // Строительные базы — от новой кромки (shoveBases): дома на новом месте план уже снёс, остальное — за счёт города.
    // Что-то не снести (план такого не пропустил бы) — база остаётся, где была.
    for (const base of this.construction.crews.bases.values()) {
      const res = this.baseShove(this.roads.net, base, [seg]);
      if (!res || (!res.moved && res.nodeId === base.nodeId)) continue;
      const under = this.structuresUnder(res.fp, 1, base);
      if (under.blocker) continue;
      if (under.houses.length) this.demolish(under.houses);
      const from = [Math.round(base.fp.center.x), Math.round(base.fp.center.y)];
      this.relocateBase(base, res.fp, res.nodeId);
      this.journal.add('base>', { id: base.id, name: this.baseName(base.id), from, pos: [Math.round(res.fp.center.x), Math.round(res.fp.center.y)], shove: true });
    }
    // Полотно со стоянкой: дома уже ужали участки по своей стороне (applyCurbSqueeze) — не двигать по самой широкой.
    if (!houses) return;
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
    if (moved) this.townRev++;
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
    // Сеть дорог заменили правкой (перенос, изгиб): техника на подвинутых строящихся полотнах — вместе с ними, сразу (и на паузе).
    this.construction.syncNet();
    this.pruneRoundabouts();
    // Новые подъезды перекрёстков — переходы «сами», до сборки графа (он отодвигает стоп-линии перед ними).
    this.syncCrosswalks();
    this.roads.changed();
    // Узел ворот базы правка могла убрать (перенос дороги, слияние стыка, снос) — ворота заново.
    this.healBaseGates();
    this.net.rebuild();
    const splits = [...this.net.pendingSplits];
    this.net.pendingSplits = [];
    this.rail.validate(splits);
    this.refreshCrossings();
    // Станции у получателей — узел за двором по новой сети.
    for (const st of this.stations.values()) if (st.kind === 'dock') this.refreshDock(st);
  }

  /** Переезды заново (дороги или пути поменялись): машины ждут у закрытых, поезда их закрывают. */
  private refreshCrossings(): void {
    // Переезды — только на открытых дорогах: у строящейся шлагбаумов ещё нет.
    this.levelCrossings = findCrossings(this.roads.open, this.net);
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
        { trusted: true, only: (c) => mine.has(c.id), project: true },
      );
      const next = road.net;
      if (road.ok && next) {
        const lost = [...this.stations.values()].some((st) => st.kind !== 'rail' && st.kind !== 'dock' && this.roads.net.nodes.has(st.nodeId) && !next.nodes.has(st.nodeId));
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
    // «Со строительством» дороги куска — проект: денег должно хватать только на то, что платится сразу (cost).
    const reason = shortOfMoney(cost, this.budget, road?.project) ? 'Не хватает денег' : undefined;
    return {
      ok: !reason,
      reason,
      cost,
      spend: (road?.spend ?? 0) + railSpend,
      refund: (road?.refund ?? 0) + railRefund,
      demolish: [...razed],
      net: road?.net ?? null,
      changed: road?.changed ?? [],
      // Проект стройки из дорог куска — для подписи (строит его road).
      project: road?.project,
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
      ground: () => this.ground(),
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
      ground: () => this.ground(),
      obstaclesAt: (p, r) => this.obstaclesAt(p, r),
      demolishCost: (id) => this.demolishCost(id),
      demolish: () => {},
      spend: () => {},
      refund: () => {},
      networkChanged: () => {},
      railConflict: (n, c) => this.railConflict(n, c, rails),
      projectId: () => this.projectId(),
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
    const chain = trackChain(net, hit.seg);
    // Координата вдоль цепочки.
    const { starts, at: along } = chainCoords(chain);
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
    // Высота — только там, где ляжет новый путь: мост или тоннель дальше по той же цепочке не мешает.
    const levelProblem = parallelLevelProblem(net, chain, starts, u0, u1);
    if (levelProblem) return fail(levelProblem);
    // Копия цепочки сбоку — параллелью по всей длине (длинные и S-образные кривые — несколькими кусками).
    const reqs: RoadRequest[] = chainOffset(chain, u0, u1, side * TRACK_GAP).map((curve) => ({
      start: { kind: 'free', pos: curve.p0, level: 0 },
      end: { kind: 'free', pos: curve.p3, level: 0 },
      spec: RAIL_SPEC,
      mode: 'straight',
      curve,
    }));
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
        this.undo(false);
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
  signalPlan(p: Vec, radius: number, oneWay = false): SignalPlan {
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
      const has = !!node.signals?.includes(out.id);
      // Тот же сигнал — снять; сигнал другого типа — поменять тип (бесплатно).
      const retype = has && !!node.oneWay?.includes(out.id) !== oneWay;
      const remove = has && !retype;
      return { ok: true, pos: node.pos, dir: d, nodeId: near, outSeg: out.id, remove, retype, oneWay, cost: has ? 0 : COST.signal };
    }
    if (seg.length < 2 * MIN_SEGMENT_LEN) return { ok: false, reason: 'Слишком короткий участок' };
    return { ok: true, pos: hit.point, dir: d, segId: seg.id, t: hit.t, forward: along, remove: false, oneWay, cost: COST.signal };
  }

  /** Ставит, снимает или меняет тип сигнала по плану signalPlan; oneWay — запрещающий встречное движение. */
  toggleSignal(p: Vec, radius: number, oneWay = false): boolean {
    const plan = this.signalPlan(p, radius, oneWay);
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
    if (!plan.retype) node.signals = plan.remove ? list.filter((s) => s !== out) : [...list, out!];
    // Запрет встречного движения — только у сигнала, который есть и который односторонний.
    const ways = (node.oneWay ?? []).filter((s) => s !== out);
    if (oneWay && !plan.remove) ways.push(out!);
    if (ways.length) node.oneWay = ways;
    else delete node.oneWay;
    if (plan.cost) this.spend(plan.cost);
    this.net.touch(nodeId);
    this.networkChanged();
    return true;
  }

  // ---------- Кредит ----------

  /** Берёт кредит шагом loanStep, пока не достигнут предел. Деньги — не доход: в отчёте отдельно. */
  takeLoan(): boolean {
    const E = ECONOMY;
    const amount = Math.min(E.loanStep, this.loanMax - this.loan);
    if (amount <= 0) return false;
    this.loan += amount;
    this.money += amount;
    this.journal.add('loan', { take: amount, loan: this.loan, money: this.money });
    return true;
  }

  /** Предел кредита: в сценарии — по сложности. */
  get loanMax(): number {
    return this.scenario?.loanMax ?? ECONOMY.loanMax;
  }

  /** Награда или субсидия сценария: доход отдельной статьёй. */
  grant(amount: number): void {
    this.money += amount;
    this.incomeMonth += amount;
    this.ledger.grants = (this.ledger.grants ?? 0) + amount;
  }

  /** Штраф сценария. */
  fine(amount: number): void {
    this.money -= amount;
    this.expensesMonth += amount;
    this.ledger.fines = (this.ledger.fines ?? 0) + amount;
  }

  /** Гасит кредит шагом loanStep (или остаток), если хватает денег. */
  repayLoan(): boolean {
    const amount = Math.min(ECONOMY.loanStep, this.loan);
    if (amount <= 0 || this.freeMoney < amount) return false;
    this.loan -= amount;
    this.money -= amount;
    this.journal.add('loan', { repay: amount, loan: this.loan, money: this.money });
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
    if ([...this.stations.values()].some((st) => st.kind !== 'dock' && st.nodeId === n.id)) return fail('Это выезд станции');
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

  /**
   * Правка фаз светофора (src/lanes/lights.ts: toggleTurn, addPhase, movePhase…): начинается с фаз, что работают
   * сейчас (и «Авто», и дополненных для новых поворотов), — дальше фазы узла заданы игроком.
   */
  editPhases(nodeId: number, edit: (spec: PhaseSpec[]) => PhaseSpec[]): void {
    const n = this.roads.net.nodes.get(nodeId);
    const L = this.roads.graph.nodes.get(nodeId)?.lights;
    if (!n || !L) return;
    n.phases = edit(specOf(L.phases));
    this.roads.net.version++;
    this.networkChanged();
  }

  /** Фазы светофора — снова «Авто» (встречные подъезды вместе, зелёный по умолчанию). */
  resetPhases(nodeId: number): void {
    const n = this.roads.net.nodes.get(nodeId);
    if (!n || (!n.phases && !n.greens)) return;
    delete n.phases;
    delete n.greens;
    this.roads.net.version++;
    this.networkChanged();
  }

  /**
   * С какими поворотами из go пересечётся поворот turn, если дать ему зелёный в той же фазе, а уступать некому
   * (поперечные потоки). Пусто — можно.
   */
  phaseClashes(nodeId: number, go: string[], turn: string): string[] {
    const g = this.roads.graph;
    return turnClashes(g.junctionMoves.get(nodeId) ?? [], (m) => g.turnOf(m), go, turn);
  }

  /** Повороты перекрёстка в фазе i светофора: едет, уступает, нельзя (пересечёт зелёный) — src/lanes/lights.ts. */
  phaseStates(nodeId: number, i: number): Map<string, TurnState> | null {
    const g = this.roads.graph;
    const ph = g.nodes.get(nodeId)?.lights?.phases[i];
    return ph ? phaseTurnStates(g.junctionMoves.get(nodeId) ?? [], (m) => g.turnOf(m), ph.go) : null;
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
      // Запрещённый поворот — тоже выезд: связь полос туда снимает запрет (кнопок запрета в карточке больше нет).
      const exits = outs.filter((o) => o.corridor !== l.corridor).map((o) => o.corridor);
      l.lanes.forEach((lane, idx) => {
        const i = l.lanes.length - 1 - idx;
        // Перед переходом — у отодвинутой стоп-линии, не на зебре.
        const pose = g.lanePose(lane, Math.max(0, lane.length - 6 - (g.stopBack.get(lane.id) ?? 0)));
        res.push({ kind: 'in', seg: l.corridor, i, lane: lane.id, pos: pose.pos, dir: pose.dir, custom: custom.has(`${l.corridor}.${i}`), exits });
      });
    }
    const walked = new Set((g.crosswalks.get(nodeId) ?? []).map((w) => w.outLink));
    for (const l of outs) {
      // На выезде с переходом — за зеброй.
      const u = walked.has(l.id) ? 7.5 + XWALK.gap + XWALK.depth : 6;
      l.lanes.forEach((lane, idx) => {
        const pose = g.lanePose(lane, Math.min(lane.length, u));
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
    } else {
      lanes.push(key);
      // Связь в запрещённую сторону — поворот снова разрешён.
      const turn = `${inSeg}>${outSeg}`;
      if (n.bans?.includes(turn)) {
        n.bans = n.bans.filter((b) => b !== turn);
        if (!n.bans.length) delete n.bans;
      }
    }
    n.lanes = lanes;
    this.roads.net.version++;
    this.networkChanged();
    return null;
  }

  // ---------- Пешеходные переходы (docs/CROSSWALKS.md) ----------

  /** Переход «сам» по городу: у концов зебры (на тротуарах) ближе WALK_HOUSES стоит дом города. */
  walkUrban(arm: WalkArm): boolean {
    const geo = walkGeo(arm);
    for (const p of geo.ends) {
      for (const s of this.index.near(p, WALK_HOUSES + 20)) {
        if (s.type === 'building' && dist(s.fp.center, p) < WALK_HOUSES + Math.max(s.fp.w, s.fp.h) / 2) return true;
      }
    }
    return false;
  }

  /**
   * Переходы «сами» у перекрёстков сети дорог: у подъездов без настройки (новых, из старого сохранения); all — и у
   * прежних «само» (город вырос). Выбор игрока не трогает. true — что-то поменялось (версия сети выросла).
   */
  syncCrosswalks(all = false): boolean {
    const net = this.roads.net;
    let changed = false;
    for (const n of net.nodes.values()) {
      if (n.kind !== 'junction' && !n.walks) continue;
      // Все подъезды уже решены — смотреть нечего (кроме месячного пересчёта).
      if (!all && n.walks && n.corridors.every((id) => String(id) in n.walks!) && Object.keys(n.walks).length === n.corridors.length) continue;
      if (syncWalks(net, n, (arm) => this.walkUrban(arm), all)) changed = true;
    }
    if (changed) net.version++;
    return changed;
  }

  /** Подъезды перекрёстка с переходами: можно ли, есть ли, кто решил, геометрия, «само» и цена разметки. */
  crosswalkInfo(nodeId: number): { arm: WalkArm; geo: WalkGeo; auto: boolean; cost: number }[] {
    const n = this.roads.net.nodes.get(nodeId);
    if (!n || n.kind !== 'junction') return [];
    return walkArms(this.roads.net, n).map((arm) => {
      const geo = walkGeo(arm);
      return { arm, geo, auto: !arm.ban && this.walkUrban(arm), cost: walkCost(geo) };
    });
  }

  /**
   * Переход на подъезде corridor перекрёстка nodeId — включить или выключить (on не задан — наоборот). Разметка — за
   * деньги, стереть — бесплатно. Ошибка — текстом, null — получилось. Снимок для Ctrl+Z делает вызывающий.
   */
  setCrosswalk(nodeId: number, corridor: number, on?: boolean): string | null {
    const info = this.crosswalkInfo(nodeId).find((x) => x.arm.corridor.id === corridor);
    if (!info) return 'Нет такого подъезда';
    if (info.arm.ban) return `Переход нельзя: ${WALK_BAN_TEXT[info.arm.ban]}`;
    const want = on ?? !info.arm.on;
    if (want === info.arm.on && info.arm.own) return null;
    if (want && !info.arm.on && info.cost > this.budget) return 'Не хватает денег';
    const n = this.roads.net.node(nodeId);
    setWalk(n, corridor, want);
    if (want && !info.arm.on) this.spend(info.cost);
    this.roads.net.version++;
    this.networkChanged();
    this.walkCatchment(n.pos);
    return null;
  }

  /** Все переходы перекрёстка — включить или выключить (где можно). Сколько стоит включить — crosswalkInfo. */
  setCrosswalks(nodeId: number, on: boolean): string | null {
    const arms = this.crosswalkInfo(nodeId).filter((x) => !x.arm.ban && (x.arm.on !== on || !x.arm.own));
    if (!arms.length) return null;
    const cost = on ? arms.filter((x) => !x.arm.on).reduce((s, x) => s + x.cost, 0) : 0;
    if (cost > this.budget) return 'Не хватает денег';
    const n = this.roads.net.node(nodeId);
    for (const x of arms) setWalk(n, x.arm.corridor.id, on);
    if (cost) this.spend(cost);
    this.roads.net.version++;
    this.networkChanged();
    this.walkCatchment(n.pos);
    return null;
  }

  /**
   * Сколько подъездов у точки at в радиусе R, где город хотел бы переход («само» — вкл), а игрок его стёр: жители по ту
   * сторону улицы к остановке не идут (computeCatchment).
   */
  missingCrosswalks(at: Vec, R: number): number {
    let count = 0;
    for (const n of this.roads.net.nodesNear(at, R)) {
      if (n.kind !== 'junction' || !n.walks) continue;
      for (const [k, w] of Object.entries(n.walks)) {
        if (w.on || !w.own) continue;
        const arm = walkArms(this.roads.net, n).find((a) => String(a.corridor.id) === k);
        if (arm && !arm.ban && this.walkUrban(arm)) count++;
      }
    }
    return count;
  }

  /** Переход поменялся — охват пассажирских станций рядом заново. */
  private walkCatchment(at: Vec): void {
    for (const st of this.stations.values()) if (st.serves.pax && dist(st.fp.center, at) < this.catchmentRadius(st) + 10) this.computeCatchment(st);
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
    // Фазы светофора: какие повороты едут вместе, кто из них уступает, где конфликт, сколько горит зелёный, какая сейчас.
    const L = g.nodes.get(nodeId)?.lights;
    const moves = g.junctionMoves.get(nodeId) ?? [];
    const turnOf = new Map(moves.map((m) => [m.key, g.turnOf(m)]));
    const turnsOf = (keys: Iterable<string>) => [...new Set([...keys].map((k) => turnOf.get(k)).filter((t): t is string => !!t))];
    const phases: JunctionPhase[] = (L?.phases ?? []).map((ph, i) => ({
      go: ph.go,
      green: ph.green,
      active: !!L && i === L.phase,
      clearing: !!L && i === L.phase && L.clearing,
      extra: !!ph.extra,
      yields: turnsOf([...ph.yields.keys()]),
      clashes: turnsOf(ph.clashes.flat()),
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
      phasesCustom: !!n.phases?.length,
      liveTurns: turnsOf(moves.map((m) => m.key)),
      label,
      customLanes,
    };
  }

  /**
   * Главная дорога перекрёстка — пара полотен, которой уступают остальные. null — главной нет:
   * равнозначный, светофор, кольцо или дорог меньше трёх. choice — показать другой выбор, не меняя
   * узел (как `mainPair`: null — «Авто», [] — равнозначный); не задан — то, что выбрано сейчас.
   */
  junctionMain(nodeId: number, choice: number[] | null | undefined = this.roads.net.nodes.get(nodeId)?.mainPair): [number, number] | null {
    const n = this.roads.net.nodes.get(nodeId);
    if (!n || n.kind !== 'junction' || n.control === 'lights' || (n.roundabout ?? null) !== null) return null;
    return mainPairOf(this.roads.net.ends(n), choice);
  }

  // ---------- Рельеф ----------

  /**
   * Мазок кисти рельефа в точке p: что изменится и сколько стоит. Нельзя в воде, у края карты и под
   * предприятием, станцией или ратушей; дома и дороги — можно (дороги ложатся на новый рельеф).
   */
  terraformPlan(p: Vec, mode: TerraformMode, r: number, target?: number): { ok: boolean; reason?: string; cost: number; edit: TerraformEdit } {
    const edit: TerraformEdit = { x: p.x, y: p.y, r, mode, amount: mode === 'flatten' ? 1 : 1.5, target };
    const fail = (reason: string) => ({ ok: false, reason, cost: 0, edit });
    if (!this.terrain.hasRelief) return fail('В этом мире нет рельефа');
    if (!this.inBounds(p, r * 0.5)) return fail('За краем карты');
    if (this.isWater(p, r * 0.3)) return fail('Здесь вода');
    for (const s of this.index.near(p, r + 120)) {
      if (s.type === 'building' && s.kind !== 'landmark') continue;
      if (!pointInFootprint(p, s.fp, r * 0.7)) continue;
      return fail(s.type === 'industry' ? 'Мешает предприятие' : s.type === 'station' ? 'Мешает станция' : 'Мешает ратуша');
    }
    const volume = this.terrain.terraformVolume(edit);
    const cost = Math.round(volume * COST.terraform);
    if (volume < 1) return { ok: false, reason: mode === 'flatten' ? 'Здесь уже ровно' : mode === 'lower' ? 'Ниже — вода' : 'Нечего менять', cost: 0, edit };
    if (cost > this.budget) return { ok: false, reason: 'Не хватает денег', cost, edit };
    return { ok: true, cost, edit };
  }

  /** Мазок кисти рельефа (снимок для Ctrl+Z делает тот, кто ведёт кисть). */
  terraform(p: Vec, mode: TerraformMode, r: number, target?: number): boolean {
    const plan = this.terraformPlan(p, mode, r, target);
    if (!plan.ok) return false;
    this.terrain.terraform(plan.edit);
    this.spend(plan.cost);
    return true;
  }

  // ---------- Отмена строительства ----------

  private readonly undoStack: UndoSnapshot[] = [];
  /** Снимок сделан, действие ещё идёт (например, тянем снос мышью). */
  private undoPending = false;

  /** Отменённые стройки для повтора (Ctrl+Y): снимки построек, какими они были до отмены; новое действие их забывает. */
  private readonly redoStack: UndoSnapshot[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Запоминает постройки перед действием игрока: дороги, пути, станции, здания, кольца. */
  checkpoint(label: string): void {
    if (this.undoPending) this.commit();
    this.undoPending = true;
    this.undoStack.push(this.captureBuilt(label));
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  /** Снимок построек сейчас: дороги, пути, станции, дома, пристройки, кольца, рельеф, проекты и базы стройки. */
  private captureBuilt(label: string): UndoSnapshot {
    return {
      label,
      roads: this.roads.net.clone(),
      roadsVersion: this.roads.net.version,
      net: structuredClone(this.net.serialize()),
      version: this.net.version,
      stations: [...this.stations.values()].map((s) => structuredClone(this.stationToSave(s))),
      buildings: this.towns.map((t) => ({ townId: t.id, list: t.buildings.map((b) => structuredClone(b)) })),
      parks: this.towns.filter((t) => t.parks?.length).map((t) => ({ townId: t.id, list: t.parks!.map((k) => ({ id: k.id, fp: structuredClone(k.fp), moved: k.moved, turn: k.turn })) })),
      industries: this.industries.map((i) => ({ id: i.id, level: i.level, streak: i.streak, annexes: i.annexes && structuredClone(i.annexes) })),
      roundabouts: [...this.roundaboutCenters].map(([id, c]) => [id, { ...c }]),
      terraform: this.terrain.edits.length,
      moneyBefore: this.money,
      spent: 0,
      projects: this.construction.projects.size ? this.construction.snapshot() : undefined,
      bases: this.construction.crews.bases.size ? [...this.construction.crews.bases.values()].map((b) => ({ id: b.id, fp: structuredClone(b.fp), nodeId: b.nodeId })) : undefined,
      // Оси запретов не меняются — списки копируем, точки общие.
      streetBans: this.towns.filter((t) => t.streetBans?.length).map((t) => ({ townId: t.id, list: [...t.streetBans!] })),
      lots: this.towns.filter((t) => t.lots?.length).map((t) => ({ townId: t.id, list: lotsShape(t.lots) })),
    };
  }

  /** Площадки как в снимке (отмена, повтор); счёт за месяц — живой, по id. */
  private restoreLots(snap: UndoSnapshot): void {
    if (!snap.lots) return;
    for (const t of this.towns) {
      const list = snap.lots.find((x) => x.townId === t.id)?.list;
      const live = new Map((t.lots ?? []).map((l) => [l.id, l]));
      if (!list?.length) {
        if (t.lots?.length) delete t.lots;
        continue;
      }
      t.lots = list.map((l) => {
        const was = live.get(l.id);
        return { ...structuredClone(l), ...(was?.month ? { month: was.month } : {}), ...(was?.last ? { last: was.last } : {}) };
      });
    }
    this.lotRev++;
    this.layoutRev++;
  }

  /** Площадки изменились с момента снимка. */
  private lotsChanged(snap: UndoSnapshot): boolean {
    const now = JSON.stringify(this.towns.filter((t) => t.lots?.length).map((t) => ({ townId: t.id, list: lotsShape(t.lots) })));
    return now !== JSON.stringify(snap.lots ?? []);
  }

  /**
   * Нарисованное в плитках могло поменяться всё (действие игрока, отмена, повтор): номера правок всех видов — вперёд
   * (стройка — Construction.stamp).
   */
  private touchBuilt(): void {
    this.industryRev++;
    this.townRev++;
    this.stationRev++;
    this.construction.stamp++;
  }

  /** Действие закончено: если ничего не построили и не снесли, снимок не нужен. */
  commit(): void {
    if (!this.undoPending) return;
    this.undoPending = false;
    // Действие игрока могло поменять что угодно из нарисованного — отрисовка сверит всё (сверх правок на местах).
    this.touchBuilt();
    const top = this.undoStack[this.undoStack.length - 1];
    if (!top) return;
    const changed =
      top.version !== this.net.version ||
      top.roadsVersion !== this.roads.net.version ||
      top.stations.length !== this.stations.size ||
      top.buildings.some((b) => this.towns.find((t) => t.id === b.townId)?.buildings.length !== b.list.length) ||
      top.moneyBefore !== this.money ||
      top.terraform !== this.terrain.edits.length ||
      this.lotsChanged(top) ||
      (top.bases ?? []).some((s) => {
        const b = this.construction.crews.bases.get(s.id);
        return !!b && !sameBasePlace(b, s);
      });
    if (!changed) this.undoStack.pop();
    else {
      top.spent = top.moneyBefore - this.money;
      this.journalBuild(top);
      // Дорога игрока на месте снесённой улицы — запрет снят; снесённые городские улицы город больше не строит.
      if (top.roadsVersion !== this.roads.net.version) {
        this.liftStreetBans();
        this.banStreets(top.roads);
      }
      // Новое действие после отмены — отменённое больше не повторить.
      this.redoStack.length = 0;
    }
  }

  /** Стройка или снос в журнал: что, за сколько, насколько изменилось число полотен, путей и станций. */
  private journalBuild(top: UndoSnapshot): void {
    const net = this.roads.net;
    const length = (n: LaneNet) => [...n.corridors.values()].reduce((s, c) => s + c.length, 0);
    // Что построено: длина новых полотен по классу, полосам в обе стороны, ограничению скорости и высоте.
    const kinds: Record<string, number> = {};
    for (const c of net.corridors.values()) {
      if (top.roads.corridors.has(c.id)) continue;
      const fwd = c.lanes.filter((l) => l.flow > 0).length;
      const back = c.lanes.filter((l) => l.flow < 0).length;
      const level = Math.max(net.node(c.a).level, net.node(c.b).level) > 0 ? ' мост' : Math.min(net.node(c.a).level, net.node(c.b).level) < 0 ? ' тоннель' : '';
      const key = `${c.cls} ${fwd}+${back}${c.limit ? ` ${c.limit}км/ч` : ''}${level}`;
      kinds[key] = Math.round((kinds[key] ?? 0) + c.length);
    }
    this.journal.add('build', {
      what: top.label,
      $: top.spent,
      roads: net.corridors.size - top.roads.corridors.size,
      len: Math.round(length(net) - length(top.roads)),
      kinds: Object.keys(kinds).length ? kinds : undefined,
      rails: this.net.segments.size - top.net.segments.length,
      stations: this.stations.size - top.stations.length,
    });
  }

  /** После правок линий старые снимки могли бы сломать маршруты — забываем их. */
  forgetUndo(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /**
   * Отменяет последнюю стройку: возвращает сеть, станции, дома и кольца как были
   * и возвращает потраченные деньги. Заработанное за это время остаётся,
   * машины и поезда продолжают путь (кто оказался на снесённом участке — вернётся на станцию).
   * redoable — отменённое можно повторить (Ctrl+Y); откат неудавшегося действия (кусок не встал) — нельзя.
   */
  undo(redoable = true): string | null {
    this.commit();
    const snap = this.undoStack.pop();
    if (!snap) return null;
    // Действие заложило проект, а стройка уже идёт (или кончилась): готовые участки — уже дороги, их убирает
    // только снос. Отмена — как «✕ Отмена» проекта: недостроенное прочь, заплаченное за него назад.
    const started = (snap.creates ?? []).filter((id) => {
      const p = this.construction.projects.get(id);
      return !p || p.spent > 0 || p.builtLen > 0;
    });
    if (started.length) {
      for (const id of snap.creates!) this.cancelProject(id, false);
      this.journal.add('undo', { what: snap.label, back: 0, projects: started });
      this.notify('Стройка уже шла: недостроенное убрано, готовые участки остались — их убирает снос', '#e5a33b');
      // Это не возврат к прежнему, а отмена проектов — повторять нечего (и прежние повторы уже не к месту).
      this.redoStack.length = 0;
      return snap.label;
    }
    // Для повтора — постройки, какими они были до отмены, и то, что отмена вернёт поверх них (дома, рельеф).
    const redo = redoable ? this.captureBuilt(snap.label) : null;
    if (redo) {
      redo.spent = snap.spent;
      redo.creates = snap.creates;
      redo.terraformRedo = this.terrain.edits.slice(snap.terraform);
      redo.dropBuildings = snap.buildings
        .map(({ townId, list }) => {
          const have = new Set(this.towns.find((t) => t.id === townId)?.buildings.map((b) => b.id));
          return { townId, ids: list.filter((b) => !have.has(b.id)).map((b) => b.id) };
        })
        .filter((d) => d.ids.length);
    }
    this.restoreBuilt(snap);

    // Деньги за стройку — назад.
    this.money += snap.spent;
    this.expensesMonth -= snap.spent;
    this.ledger.build -= Math.min(this.ledger.build, snap.spent);
    this.journal.add('undo', { what: snap.label, back: snap.spent });
    if (redo) this.redoStack.push(redo);
    else this.redoStack.length = 0;
    return snap.label;
  }

  /**
   * Повторяет последнюю отменённую стройку (Ctrl+Y, Ctrl+Shift+Z): постройки — какими были до отмены, деньги за
   * стройку — снова списаны; отменить её можно опять. null — повторять нечего.
   */
  redo(): string | null {
    this.commit();
    const snap = this.redoStack.pop();
    if (!snap) return null;
    const back = this.captureBuilt(snap.label);
    back.spent = snap.spent;
    back.creates = snap.creates;
    this.restoreBuilt(snap, snap.dropBuildings);
    // Мазки кисти, что убрала отмена, — снова (рельеф после отмены не менялся: новый мазок забыл бы повтор).
    for (const e of snap.terraformRedo ?? []) this.terrain.terraform(e);

    // Деньги за стройку — снова, как при самой стройке.
    this.money -= snap.spent;
    this.expensesMonth += snap.spent;
    this.ledger.build += snap.spent;
    this.journal.add('redo', { what: snap.label, $: snap.spent });
    this.undoStack.push(back);
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
    return snap.label;
  }

  /**
   * Постройки — как в снимке snap (отмена или повтор): сеть, станции, дома, пристройки, кольца, рельеф, проекты и базы
   * стройки. drop — дома, которых в снимке нет и которые надо снести (повтор сноса); выросшие сами — остаются.
   */
  private restoreBuilt(snap: UndoSnapshot, drop?: { townId: number; ids: number[] }[]): void {
    const railSave = this.rail.serialize();
    this.rail.clearTrains();
    // Ж/д проекты с тех пор ушли вперёд — готовое на путях переносим (оно уже оплачено), как у дорог (carryBuild).
    const railBuilt = new Map([...this.net.segments.values()].map((s) => [s.id, { build: s.build, p0: s.curve.p0, p3: s.curve.p3 }]));
    this.net.replaceWith(snap.net);
    carryRailBuild(railBuilt, this.net);
    // Перенесённая станция вернётся на старый узел: машины, что едут к ней, — туда же.
    const nodeBack = new Map(snap.stations.filter((s) => this.stations.get(s.id)?.nodeId !== s.nodeId).map((s) => [s.id, s.nodeId]));
    for (const v of this.fleet.values()) {
      const line = this.lines.get(v.lineId);
      const sim = this.fleetSim(v);
      const back = line && nodeBack.get(line.stops[v.stop]);
      if (sim && back !== undefined && !v.boarding) sim.targetNode = back;
    }
    // Машины переезжают на восстановленные дороги сами; кому некуда — вернутся на станцию.
    // Стройка с тех пор ушла вперёд — готовое переносим (оно уже оплачено); записи проектов — как в снимке.
    const roads = snap.roads.clone();
    carryBuild(this.roads.net, roads);
    this.roads.replace(roads);
    this.construction.restore(snap.projects ?? []);
    // Запреты улиц — как были: отмена сноса улицы снимает её запрет, повтор — ставит снова.
    if (snap.streetBans) {
      for (const t of this.towns) {
        const list = snap.streetBans.find((b) => b.townId === t.id)?.list;
        if (list?.length) t.streetBans = [...list];
        else delete t.streetBans;
      }
    }
    // Площадки-стоянки — как были (поставленная действием уходит, снесённая и перенесённая — как в снимке).
    this.restoreLots(snap);

    // Станции: живые остаются (со своими грузами и пассажирами), лишние уходят, снесённые возвращаются.
    const keep = new Set(snap.stations.map((s) => s.id));
    for (const st of [...this.stations.values()]) {
      // Станция у получателя — не постройка: её ставит и убирает маршрут, отмена стройки её не трогает.
      if (keep.has(st.id) || st.kind === 'dock') continue;
      this.index.remove(st);
      this.stations.delete(st.id);
    }
    for (const s of snap.stations) {
      const live = this.stations.get(s.id);
      if (live?.kind === 'dock' || (!live && s.kind === 'dock')) continue;
      if (live) {
        // Посты погрузки, площадка и её место (перенос станции, навес остановки у нового бордюра) — как были до действия.
        const same = live.fp.w === s.fp.w && live.fp.center.x === s.fp.center.x && live.fp.center.y === s.fp.center.y && live.fp.angle === s.fp.angle;
        if (live.bays !== s.bays || (live.depots ?? 0) !== (s.depots ?? 0) || !same || live.nodeId !== s.nodeId || live.industryId !== s.industryId) {
          this.index.remove(live);
          live.fp = s.fp;
          live.bays = s.bays;
          live.depots = s.depots;
          live.nodeId = s.nodeId;
          live.industryId = s.industryId;
          // Длина выезда — как была (её меняют вместе с местом площадки).
          if (s.driveway !== undefined) live.driveway = s.driveway;
          else delete live.driveway;
          this.index.add(live);
        }
        // Ж/д станция: пути с платформами и тип (достроенный путь, перенос со сменой типа) — как были.
        if (live.kind === 'rail') {
          live.platforms = [...(s.platforms ?? [])];
          if (s.terminal) live.terminal = true;
          else delete live.terminal;
        }
        // Склады-здания — как были до действия (в индекс — ниже, все разом).
        live.warehouses = s.warehouses;
        // Пара остановок (перенос её сложил или разорвал) — как была, с прежним названием.
        if (live.pair !== s.pair) {
          if (s.pair !== undefined) live.pair = s.pair;
          else delete live.pair;
          live.name = s.name;
        }
        continue;
      }
      const st = this.stationFromSave(s);
      this.stations.set(st.id, st);
      this.index.add(st);
    }
    this.checkPairs();
    // Строительные базы — на места до действия (перенос, отодвинутая расширением улицы); свободные бригады едут к
    // прежним воротам по дорогам, как при переносе.
    for (const s of snap.bases ?? []) {
      const live = this.construction.crews.bases.get(s.id);
      if (live && !sameBasePlace(live, s)) this.relocateBase(live, structuredClone(s.fp), s.nodeId);
    }
    // Пристройки предприятий: поставленную или снесённую действием — как было, с уровнем, который она дала.
    for (const s of snap.industries ?? []) {
      const ind = this.industries.find((i) => i.id === s.id);
      if (!ind || (ind.annexes?.length ?? 0) === (s.annexes?.length ?? 0)) continue;
      ind.annexes = s.annexes;
      ind.level = s.level;
      ind.streak = s.streak;
    }
    this.indexWarehouses();
    // Дома: снесённые возвращаются, перенесённые встают на старое место,
    // а выросшие с тех пор сами по себе — остаются.
    for (const { townId, list } of snap.buildings) {
      const town = this.towns.find((t) => t.id === townId);
      if (!town) continue;
      const gone = new Set(drop?.find((d) => d.townId === townId)?.ids);
      const now = new Map(town.buildings.map((b) => [b.id, b]));
      for (const old of list) {
        const cur = now.get(old.id);
        if (cur) this.index.remove(cur);
        now.set(old.id, old);
        this.index.add(old);
      }
      // Дома у улиц, которые город проложил после снимка (их отмена убрала), уходят вместе с ними; дома из снимка
      // остаются, какими были (и те, чью улицу действие обрезало снаружи рамки сноса).
      // Повтор сноса: дома, что вернула отмена, — снова прочь.
      const kept = new Set(list.map((b) => b.id));
      town.buildings = [...now.values()].filter((b) => {
        if (!gone.has(b.id) && (kept.has(b.id) || this.roads.net.nodes.has(b.anchor))) return true;
        this.index.remove(b);
        return false;
      });
      recountPopulation(town);
    }
    // Парки — на места до действия (перенос парка, площадь, что уехала с ратушей); новый список — карте и выбору.
    for (const { townId, list } of snap.parks ?? []) {
      const town = this.towns.find((t) => t.id === townId);
      if (!town?.parks) continue;
      let moved = false;
      for (const s of list) {
        const live = town.parks.find((k) => k.id === s.id);
        if (!live || (sameFootprint(live.fp, s.fp) && live.moved === s.moved && live.turn === s.turn)) continue;
        live.fp = structuredClone(s.fp);
        if (s.moved) live.moved = true;
        else delete live.moved;
        if (s.turn) live.turn = s.turn;
        else delete live.turn;
        moved = true;
      }
      if (moved) town.parks = [...town.parks];
    }
    this.layoutRev++;
    this.touchBuilt();
    this.terrain.truncateEdits(snap.terraform);
    this.roundaboutCenters.clear();
    for (const [id, c] of snap.roundabouts) this.roundaboutCenters.set(id, c);

    // Поезда — обратно на восстановленные пути.
    const sims = new Set(this.traffic.vehicles.keys());
    const trains = this.rail.restore(railSave);
    this.reattachFleet(sims, trains);
    this.net.rebuild();
    this.refreshCrossings();
    for (const st of this.stations.values()) this.computeCatchment(st);
  }

  // ---------- Время ----------

  get dateLabel(): string {
    return this.dateAt(this.month);
  }

  /** Дата месяца партии с этим номером (0 — первый): «Мар 2003». */
  dateAt(month: number): string {
    return `${MONTHS[month % 12]} ${this.startYear + Math.floor(month / 12)}`;
  }

  /** Номер текущего месяца с начала партии — единое время дедлайнов сценария. */
  get monthIndex(): number {
    return this.month;
  }

  /** Текущий игровой год. */
  get year(): number {
    return this.startYear + Math.floor(this.month / 12);
  }

  /**
   * В каком году партии модель выходила в продажу по прежнему календарю (до открытия по объёму перевозок): через
   * debut лет от начала, а у старой партии с месяцем длиннее — по реальному времени, раньше на paceShift месяцев
   * (с января того года, когда это время прошло). Нужен только старым сохранениям (legacyUnlocks): что к их дате уже
   * вышло, остаётся в продаже.
   */
  modelYear(id: ModelId): number {
    return this.startYear + Math.max(0, Math.ceil((12 * MODELS[id].debut - this.paceShift) / 12 - 1e-9));
  }

  /** Содержание в месяц: у поезда растёт с длиной состава. */
  runningCost(v: FleetVehicle): number {
    const m = MODELS[v.model];
    const length = m.mode === 'rail' ? 0.4 + (0.6 * carsOf(v)) / m.train.cars : 1;
    return Math.round(m.running * length);
  }

  /** Состав длиной length не встаёт ни на одну из платформ вокзала — причина для карточки линии; встаёт — null. */
  private tooLongText(st: Station, platforms: number[], length: number, carLength: number): string | null {
    const longest = Math.max(0, ...platforms.map((p) => this.net.segments.get(p)?.length ?? 0));
    if (longest >= length + 6) return null;
    return `Поезд длиннее платформ: ${st.name}, ${Math.round(longest)} м — уберите вагоны (встанет ${carsOnPlatform(longest, carLength)}) или постройте вокзал длиннее`;
  }

  /** Сколько вагонов поместится на платформы всех станций линии. */
  maxCars(v: FleetVehicle): number {
    const m = MODELS[v.model];
    const line = this.lines.get(v.lineId);
    if (m.mode !== 'rail' || !line) return 1;
    let shortest = Infinity;
    line.stops.forEach((sid, i) => {
      // Выбранный для остановки путь — по его длине, иначе — по самой длинной платформе.
      const own = this.stopPlatform(line, i);
      const platforms = own !== null ? [own] : (this.stations.get(sid)?.platforms ?? []);
      const longest = Math.max(0, ...platforms.map((p) => this.net.segments.get(p)?.length ?? 0));
      shortest = Math.min(shortest, longest);
    });
    return Math.max(2, carsOnPlatform(shortest, m.train.carLength));
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

  /** Продаётся ли модель: первого поколения — с начала, II и III — когда их семейство перевезло свой порог (unlocks.ts). */
  readonly modelOpen = (id: ModelId): boolean => this.unlocks.isOpen(id);

  /**
   * Машина довезла count единиц (груз получателю, пассажиров до их остановки) — в «Перевезено» маршрута и в счёт
   * семейства её модели; дошло до порога — модель открывается.
   */
  private carried(line: Line, v: FleetVehicle, count: number): void {
    line.carriedMonth += count;
    this.modelsReached(this.unlocks.add(v.model, count));
  }

  /** Модели открылись: запись в журнале и заметка о каждой — «Открыт Автобус II». */
  private modelsReached(fresh: ModelId[]): void {
    if (!fresh.length) return;
    this.journal.add('models', { open: fresh, carried: fresh.map((id) => Math.floor(this.unlocks.carried[familyOf(id)])) });
    for (const id of fresh)
      this.notify(`🔓 Открыт ${MODELS[id].name} — ${MODELS[id].capacity} мест. Старый транспорт можно заменить в карточке маршрута`, '#4a8fe7', { kind: 'fleet' });
  }

  /**
   * Открывает сразу все модели до ступени tier (тестовые страницы и тесты — без перевозок): с заметками, как по
   * порогу; quiet — без них.
   */
  openModelTier(tier: ModelTier, quiet = false): void {
    const fresh = this.unlocks.unlock((Object.keys(MODELS) as ModelId[]).filter((id) => MODELS[id].tier <= tier));
    if (!quiet) this.modelsReached(fresh);
  }

  /**
   * Сохранение до счёта перевозок: модели, открытые по прежним правилам — вышедшие по году (modelYear) или открытые
   * ступенью сценария (SaveData.modelTier; совсем старое — по этапу), — остаются в продаже; перевезённое по
   * семействам — по журналу и доходу нынешних линий (legacyCarried).
   */
  private legacyUnlocks(save: SaveData): ModelUnlocks {
    const tier = save.modelTier ?? (save.scenario ? Math.min(3, save.scenario.phase + 1) : 1);
    const open = (Object.keys(MODELS) as ModelId[]).filter((id) => MODELS[id].tier > 1 && (this.modelYear(id) <= this.year || MODELS[id].tier <= tier));
    const months = this.journal.entries
      .filter((e) => e.k === 'month' && Array.isArray(e.lines))
      .map((e) => (e.lines as unknown[][]).map((r) => [Number(r[0]), Number(r[3]) || 0] as [number, number]));
    const lines = [...this.lines.values()].map((l) => {
      const mode = this.lineMode(l);
      const pax = this.lineCarries(l) === 'passengers';
      const family = mode === 'rail' ? (pax ? 'paxRail' : 'freightRail') : pax ? 'bus' : 'truck';
      return { ...l, family } as const;
    });
    return new ModelUnlocks({ carried: legacyCarried(lines, months), open });
  }

  /** Модель новее того же рода, если уже продаётся. */
  replacementFor(v: FleetVehicle): ModelId | null {
    const best = newestLike(v.model, this.modelOpen);
    return best !== v.model ? best : null;
  }

  /**
   * Меняет машину на модель новее там же, где она сейчас, а не на первой станции: старая продаётся, новая
   * покупается, но это та же машина парка — номер, рейс и следующая остановка, груз и пассажиры, место в очереди
   * интервала; на дороге — то же место на полосе и скорость, на посту станции — тот же пост. Новая длиннее, а сзади
   * на дороге вплотную сосед — замена ждёт места (upgradeTo), самое позднее — до остановки. null — менять не на
   * что или не хватает денег.
   */
  replaceVehicle(id: number): FleetVehicle | null {
    const v = this.fleet.get(id);
    const model = v && this.replacementFor(v);
    if (!v || !model) return null;
    if (MODELS[model].price - this.saleValue(v) > this.budget) return null;
    v.upgradeTo = model;
    if (!this.applyUpgrade(v)) this.journal.add('replace', { v: id, model, wait: true });
    return v;
  }

  /**
   * Замена на заказанную модель (upgradeTo) на месте. Кузов на дороге длиннее, а места сзади нет — false, ждёт
   * (повторяется каждый шаг); к этому времени не хватает денег — замена отменяется. Поезд остаётся той же длины —
   * с тем же числом вагонов (добавить можно в карточке), меняются ход и торможение. Груз и пассажиры остаются
   * в машине; если новая вдруг меньше, лишнее теряется (модели новее не меньше прежних).
   */
  private applyUpgrade(v: FleetVehicle): boolean {
    const model = v.upgradeTo;
    if (!model) return false;
    const old = MODELS[v.model];
    const m = MODELS[model];
    const cost = m.price - this.saleValue(v);
    if (cost > this.budget) {
      delete v.upgradeTo;
      this.notify(`Не хватает денег на замену: ${this.vehicleTitle(v)}`, '#e5534b', { kind: 'money', refs: [{ type: 'line', id: v.lineId }] });
      return false;
    }
    if (m.mode === 'road') {
      const sim = this.fleetSim(v);
      const { color: _color, load: _load, ...body } = m.spec;
      if (sim && !this.traffic.reshape(sim, body)) return false;
    } else {
      v.cars = carsOf(v);
      const train = this.fleetTrain(v);
      if (train) Object.assign(train, { maxSpeed: m.train.maxSpeed, accel: m.train.accel, brake: m.train.brake });
    }
    const sale = this.saleValue(v);
    this.money += sale;
    this.incomeMonth += sale;
    this.ledger.sales += sale;
    this.spend(m.price, 'purchases');
    v.model = model;
    v.name = `${m.name} №${v.id}`;
    v.boughtMonth = this.month;
    delete v.upgradeTo;
    // Новая меньше (так не бывает, но вдруг) — лишнее теряется.
    const cap = vehicleCapacity(v);
    const lost = Math.max(0, vehicleLoad(v) - cap);
    if (v.cargo) v.amount = Math.min(v.amount, cap);
    for (let over = lost; over > 0 && v.passengers.length && !v.cargo; ) {
      const g = v.passengers[v.passengers.length - 1];
      const off = Math.min(over, g.count);
      g.count -= off;
      over -= off;
      if (!g.count) v.passengers.pop();
    }
    this.journal.add('replace', { v: v.id, from: old.id, model, $: cost, lost: lost || undefined });
    return true;
  }

  get monthProgress(): number {
    return (this.time % MONTH_LENGTH) / MONTH_LENGTH;
  }

  update(realDt: number): void {
    this.ageNotices(realDt);
    for (const f of this.floaters) f.age += realDt;
    while (this.floaters.length && this.floaters[0].age > 2.5) this.floaters.shift();
    // Итоги месяца ещё идут — кадр им, такты ждут (и на паузе: незаконченные итоги не оставляем).
    if (this.closing && !this.closeMonthSteps()) return;
    if (this.speed === 0) return;
    this.accumulator += Math.min(realDt, 0.1) * this.speed;
    let steps = 0;
    while (this.accumulator >= SIM_DT && steps < 24) {
      this.tick(SIM_DT);
      this.accumulator -= SIM_DT;
      steps++;
      // Месяц кончился: итоги — сколько успеют в этом кадре, остальное — в следующих.
      if (this.closing && !this.closeMonthSteps()) return;
    }
    if (steps >= 24) this.accumulator = 0;
  }

  /**
   * Шаги итогов месяца, пока не выйдет время кадра (monthBudget); true — итоги подведены. Подведены — onMonthEnd
   * (автосохранение): уже с новым месяцем, так что после загрузки итоги этого месяца не повторятся.
   */
  private closeMonthSteps(): boolean {
    // Изнутри шага (сохранение посреди итогов) — не дальше: генератор уже идёт.
    if (this.closingStep) return false;
    const until = performance.now() + this.monthBudget;
    while (this.closing) {
      this.closingStep = true;
      let done: boolean | undefined;
      try {
        done = this.closing.next().done;
      } finally {
        this.closingStep = false;
      }
      if (done) {
        this.closing = null;
        this.onMonthEnd();
      } else if (performance.now() >= until) return false;
    }
    return true;
  }

  /** Итоги месяца ещё идут (по кадрам). */
  get monthClosing(): boolean {
    return this.closing !== null;
  }

  /** Подвести итоги месяца до конца сейчас же — перед сохранением: половина итогов в сохранение не попадает. */
  settleMonth(): void {
    const budget = this.monthBudget;
    this.monthBudget = Infinity;
    try {
      this.closeMonthSteps();
    } finally {
      this.monthBudget = budget;
    }
  }

  private tick(dt: number): void {
    this.time += dt;
    // Содержание — за этот такт, по парку, бригадам, сети и долгу, какими их оставили прошлый такт и игрок.
    this.accrueUpkeep(dt);
    // Светофоры реверса на перестройке «с проездом» — до движения: красный — стоп-линия своего направления.
    if (this.construction.projects.size || this.workSignals.list.size) this.workSignals.step(dt, this.roads.net, this.roads.graph, this.traffic);
    // Пешеходы на переходах — тоже до движения: идут — зебра закрыта.
    if (this.roads.graph.crosswalks.size || this.crosswalks.list.length) this.crosswalks.step(dt, this.time, this.roads.graph, this.traffic);
    this.traffic.step(dt);
    // Техника бригад разворачивается петлёй — сразу после движения: на петле её рисуют там, где она на ней.
    if (this.construction.crews.brigades.size || !this.crewLoops.idle) this.crewLoops.step(dt);
    // Машины у гаражей частных домов и на стоянках магазинов — сразу после движения: на манёвре их рисуют там, где
    // они на нём.
    this.garages.step(dt);
    this.curb.step(dt);
    // Выезды с больших площадок (через узел ворот) и поиск места у целей.
    if (this.lots.exits.length) this.lots.step(dt);
    this.parkSearch.step();
    this.shops.step(dt, this.towns);
    this.docks.step(dt);
    // Парк машин жителей: стоящие — только данные, в такт — куча отъездов (у кого срок у цели вышел).
    this.carHomes.step();
    this.gatherCrews();
    this.rail.step(dt);
    this.updateFleet(dt);
    this.updateJams(dt);
    this.updateAutoSell();
    this.updateAutoWait();
    this.updateAutoRenew();
    // Предприятия строит игрок: стройка площадок, рабочие (enterprises.ts); «Готовые» — ничего.
    this.enterprises.tick(dt);
    this.updateIndustries(dt);
    this.updateStations(dt);
    this.updateTowns(dt);
    // Стройка дорог: только если есть проекты или бригады («Мгновенно» их не бывает — такт тот же, что без стройки).
    if (this.construction.projects.size || this.construction.crews.brigades.size || this.construction.trains?.list.size) this.construction.tick(dt);
    this.scenario?.tick(dt);
    this.ideas.tick(dt);
    const month = Math.floor(this.time / MONTH_LENGTH);
    // Итоги — сразу после такта (update): целиком или по кадрам (monthBudget).
    if (month !== this.month && !this.closing) this.closing = this.closeMonth(month);
  }

  /** Итоги месяца и переход на следующий; yield — где их можно прервать до следующего кадра. */
  private *closeMonth(month: number): Generator<void, void, void> {
    yield* this.monthEnd();
    this.month = month;
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

  /** Маршруты города: через станции и остановки, в охват которых попадают его дома. */
  townLines(townId: number): Line[] {
    return linesForTown(this.lines.values(), this.stations.values(), townId);
  }

  /** Ходит ли через станцию транспорт хоть одной линии — для отзывов жителей («автобусов нет»). */
  private served(st: Station): boolean {
    for (const l of this.lines.values()) if (l.stops.includes(st.id) && l.vehicles.length) return true;
    return false;
  }

  /**
   * Может ли маршрут возить what — тогда на его станциях копятся пассажиры или груз, даже пока машин на нём нет.
   * С машинами — как прежде: груз копится при любых машинах, пассажиры — при пассажирских. Без машин — по
   * станциям маршрута (lineKind): грузовому — груз, пассажирскому — пассажиры, смешанному — и то и другое.
   */
  lineTakes(line: Line, what: 'freight' | 'passengers'): boolean {
    if (line.vehicles.length) {
      return what === 'freight' || line.vehicles.some((id) => {
        const v = this.fleet.get(id);
        return !!v && MODELS[v.model].carries === 'passengers';
      });
    }
    const kind = this.lineKind(line);
    return kind === null || kind === what;
  }

  /** Станция стоит в маршруте, который может возить груз, — предприятия кладут на неё продукцию. */
  private routed(st: Station): boolean {
    for (const l of this.lines.values()) if (l.stops.includes(st.id) && this.lineTakes(l, 'freight')) return true;
    return false;
  }

  lineMode(line: Line): LineMode {
    return line.mode ?? 'road';
  }

  /**
   * Чем ездит линия — для значка в списках: поезд, автобус или грузовик.
   * Автолиния — по своему транспорту, а пока его нет — по станциям маршрута.
   */
  lineVehicleKind(line: Line): 'train' | 'bus' | 'truck' | 'tanker' {
    if (this.lineMode(line) === 'rail') return 'train';
    if (this.lineCarries(line) === 'passengers') return 'bus';
    return this.tankLine(line) ? 'tanker' : 'truck';
  }

  /**
   * Какие грузы возит маршрут: что производят у одной его станции и принимают у другой, и что велено грузить
   * правилами остановок (список грузов).
   */
  lineFreight(line: Line): CargoType[] {
    const sts = line.stops.map((id) => this.stations.get(id)).filter((s): s is Station => !!s);
    const out = new Set<CargoType>();
    for (const s of sts) {
      for (const ind of this.stationIndustries(s)) {
        const c = ind.info.produces;
        if (sts.some((o) => o !== s && o.accepts.has(c))) out.add(c);
      }
    }
    for (const r of line.rules ?? []) if (r && Array.isArray(r.load)) for (const c of r.load) out.add(c);
    return [...out];
  }

  /** Маршрут возит только наливные грузы (нефть, топливо, газ): его грузовики — автоцистерны, и порожняком тоже. */
  tankLine(line: Line): boolean {
    if (this.lineMode(line) !== 'road') return false;
    const cargo = this.lineFreight(line);
    return cargo.length > 0 && cargo.every(isTankCargo);
  }

  /**
   * Автоцистерна: грузовик компании везёт наливной груз, а пустой — ездит по маршруту только наливных грузов.
   * На маршруте с разными грузами грузовик с нефтью — цистерна, с зерном — фургон. Модель та же (цена, вместимость),
   * поэтому старые сохранения не меняются: машины просто выглядят и называются по грузу.
   */
  isTanker(v: FleetVehicle): boolean {
    const m = MODELS[v.model];
    if (m.mode !== 'road' || m.carries !== 'freight') return false;
    if (v.cargo) return isTankCargo(v.cargo);
    const line = this.lines.get(v.lineId);
    return !!line && this.tankLine(line);
  }

  /** Имя машины в интерфейсе: автоцистерна — «Автоцистерна №7», хотя записана, как куплена, «Грузовиком №7». */
  vehicleTitle(v: FleetVehicle): string {
    const base = `${MODELS[v.model].name} №`;
    return this.isTanker(v) && v.name.startsWith(base) ? `${modelName(v.model, true)} №${v.name.slice(base.length)}` : v.name;
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
    const people = sts.filter((s) => s.serves.pax && this.paxPop(s) > 0).length;
    if (this.freightFlow(sts)) return people >= 2 ? null : 'freight';
    return people ? 'passengers' : null;
  }

  /**
   * Чего не хватает станции на остановке index, чтобы с ней работал транспорт линии: грузовому маршруту — груза
   * (иначе грузовикам здесь нечего взять и некому сдать), пассажирскому — пассажиров; null — всё в порядке
   * или маршрут смешанный.
   */
  stopMissing(line: Line, index: number): keyof StationServes | null {
    const st = this.stations.get(line.stops[index]);
    if (!st || st.kind === 'stop') return null;
    const kind = this.lineKind(line);
    if (kind === 'freight' && !st.serves.cargo) return 'cargo';
    if (kind === 'passengers' && !st.serves.pax) return 'pax';
    return null;
  }

  /** Почему из этих станций нельзя собрать линию; null — можно. Остановки ездят вместе с автостанциями. */
  lineProblem(stops: number[]): string | null {
    const sts = stops.map((id) => this.stations.get(id)).filter((s): s is Station => !!s);
    if (new Set(sts.map(stationMode)).size > 1) return 'В одном маршруте — либо автостанции и остановки, либо ж/д станции';
    return null;
  }

  /** Цвет, который получит новая линия по этим станциям, — им же рисуется маршрут, пока его прокладывают.
   *  Грузовой маршрут — цветом груза, который везут с первой станции (его принимают дальше по маршруту, иначе —
   *  что там производят); пассажирский — первый цвет, которого ещё нет у других линий. */
  newLineColor(stops: number[]): string {
    const sts = stops.map((id) => this.stations.get(id)).filter((s): s is Station => !!s);
    const [first, ...later] = sts;
    const produced = first?.serves.cargo ? this.stationIndustries(first).map((ind) => ind.info.produces) : [];
    const cargo = produced.find((c) => later.some((s) => s.accepts.has(c))) ?? produced[0];
    if (cargo) return CARGO[cargo].color;
    const used = new Set([...this.lines.values()].map((l) => l.color));
    const n = this.lines.size ? Math.max(...this.lines.keys()) + 1 : 1;
    return LINE_COLORS.find((c) => !used.has(c)) ?? LINE_COLORS[(n - 1) % LINE_COLORS.length];
  }

  createLine(stops: number[]): Line | null {
    // Пара остановок — одна точка: автобус встанет у той половины, к которой подъедет по своей полосе.
    const known = this.pairRoute(stops.filter((id) => this.stations.has(id)));
    const clean = known.filter((id, i) => id !== known[i - 1]);
    if (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop();
    if (clean.length < 2 || this.lineProblem(clean)) return null;
    this.forgetUndo();
    const n = this.lines.size ? Math.max(...this.lines.keys()) + 1 : 1;
    const line: Line = {
      id: n,
      name: this.defaultLineName(clean),
      color: this.newLineColor(clean),
      mode: stationMode(this.stations.get(clean[0])!),
      stops: clean,
      vehicles: [],
      created: this.time / MONTH_LENGTH,
      revenueMonth: 0,
      revenueLast: 0,
      revenueTotal: 0,
      costMonth: 0,
      costLast: 0,
      carriedMonth: 0,
      carriedLast: 0,
      problem: null,
      // Интервал у нового маршрута выключен: машины уходят с первой станции, как только готовы.
      noSpacing: true,
    };
    this.lines.set(n, line);
    this.journal.add('line', { id: n, name: line.name, mode: line.mode, stops: clean });
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
  setLineRoute(id: number, given: number[], rules: (StopRule | null)[]): string | null {
    const line = this.lines.get(id);
    if (!line) return 'Нет маршрута';
    // Пара остановок — одна точка: у каждой пары — половина по ходу автобуса от предыдущей остановки.
    const stops = this.pairRoute(given);
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
    if (line.vehicles.some((id) => MODELS[this.fleet.get(id)!.model].carries === 'passengers') && clean.some((id) => this.stations.get(id)!.kind === 'dock')) {
      return 'Автобусы к магазинам не ездят';
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
      // Вместо половины пары в маршруте — другая: машина едет к ней (стоит у прежней — уезжает оттуда).
      const was = this.stations.get(at);
      const mate = this.pairOf(was);
      if (was && mate && clean.includes(mate.id)) {
        this.remapLineVehicle(v, line, was, clean.indexOf(mate.id));
        continue;
      }
      // Станции больше нет в маршруте: машина возвращается к началу маршрута.
      this.resetVehicle(v, line);
    }
    this.journal.add('route', { id, stops: clean, was: before });
    // Магазин ушёл из последнего маршрута — его невидимой станции больше нет.
    this.pruneDocks(clean);
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
    this.forgetDock(v);
    // Груз не теряется: он поедет дальше по новому маршруту.
    v.stop = MODELS[v.model].mode === 'rail' ? 0 : line.stops.length - 1;
    v.state = 'departing';
    v.timer = 1;
    v.waited = 0;
    this.forgetLap(v);
  }

  /** Машину сняли с маршрута (продали, маршрут поменяли): во дворе получателя её больше нет, ждать рампу — тоже. */
  private forgetDock(v: FleetVehicle): void {
    this.docks.forget(v.id);
    this.dockExit.delete(v.id);
    this.dockTries.delete(v.id);
    this.rampWaitSince.delete(v.id);
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
    this.journal.add('rule', { line: id, i: index, st: line.stops[index], rule });
  }

  deleteLine(id: number): void {
    const line = this.lines.get(id);
    if (!line) return;
    this.journal.add('line-', { id, name: line.name, vehicles: line.vehicles.length });
    this.forgetUndo();
    for (const vid of [...line.vehicles]) this.sellVehicle(vid);
    this.lines.delete(id);
    this.lapGuess.delete(id);
    this.pruneDocks();
  }

  /**
   * auto — купил авто-парк линии, а не игрок (в журнале так и помечено).
   * from — номер остановки маршрута, с которой машина начнёт работу (игрок перетащил покупку на остановку
   * в карточке маршрута). С первой — как обычно: новые уходят по очереди, выждав интервал. С другой — сразу:
   * грузится там и едет дальше по маршруту, интервал выжидает уже на первой станции, как все.
   */
  buyVehicle(lineId: number, model: ModelId, auto = false, from = 0): FleetVehicle | null {
    const line = this.lines.get(lineId);
    const m = MODELS[model];
    if (!line || m.price > this.budget || m.mode !== this.lineMode(line) || !this.modelOpen(model)) return null;
    // На остановке только пассажиры: грузовику там делать нечего; к магазину во двор — только грузовик.
    if (m.carries !== 'passengers' && line.stops.some((id) => this.stations.get(id)?.kind === 'stop')) return null;
    if (m.carries === 'passengers' && line.stops.some((id) => this.stations.get(id)?.kind === 'dock')) return null;
    const at = Number.isInteger(from) && from > 0 && from < line.stops.length ? from : 0;
    const first = this.stations.get(line.stops[at]);
    const id = this.nextEntityId++;
    const v: FleetVehicle = {
      id,
      name: `${m.name} №${id}`,
      model,
      lineId,
      stop: at,
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
    // Выехала не с первой станции — уже в работе: в очередь новых на первой станции не встаёт.
    if (at) delete v.fresh;
    this.fleet.set(id, v);
    line.vehicles.push(id);
    // Новый поезд — не длиннее самой короткой платформы линии, иначе ему негде встать.
    if (m.mode === 'rail' && carsOf(v) > this.maxCars(v)) v.cars = this.maxCars(v);
    this.spend(m.price, 'purchases');
    this.journal.add('buy', { v: id, model, line: lineId, $: m.price, n: line.vehicles.length, money: this.money, ...(auto ? { auto: true } : {}), ...(at ? { from: at } : {}) });
    // Новая машина сначала грузится на своей остановке; с первой новые уходят не все разом.
    if (first && m.mode === 'road') {
      this.handleStop(v, first, line);
      v.state = 'loading';
      if (!at) v.timer += line.vehicles.length * 3;
    }
    return v;
  }

  /** auto — продал авто-парк линии, а не игрок (в журнале так и помечено). */
  sellVehicle(id: number, auto = false): void {
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
    this.forgetDock(v);
    // Начисленное до продажи — сразу (в расходы линии); дальше начисления нет.
    this.payVehicleUpkeep(v, true);
    const line = this.lines.get(v.lineId);
    if (line) line.vehicles = line.vehicles.filter((x) => x !== id);
    this.fleet.delete(id);
    const sale = this.saleValue(v);
    this.money += sale;
    this.incomeMonth += sale;
    this.ledger.sales += sale;
    this.journal.add('sell', { v: id, model: v.model, line: v.lineId, $: sale, lost: v.amount || undefined, ...(auto ? { auto: true } : {}) });
  }

  // ---------- Авто-парк ----------

  /**
   * Настройки авто-парка линии. Впервые — от нынешнего числа машин (пустой линии — от нуля: первая машина
   * придёт, когда появится спрос) до 10 (машин больше — до их числа). Минимум можно опустить до 0: тогда ненужные
   * машины уйдут все, а вернутся, когда появится спрос (idleDemand). Включённый сразу докупает до минимума (если
   * хватает денег) и продаёт сверх максимума.
   */
  setLineAuto(id: number, patch: Partial<Pick<LineAuto, 'on' | 'min' | 'max' | 'renew'>>): void {
    const line = this.lines.get(id);
    if (!line) return;
    const n = line.vehicles.length;
    const top = AUTO_FLEET.maxVehicles;
    const auto = (line.auto ??= {
      on: false,
      min: Math.min(top, n),
      max: Math.min(top, Math.max(AUTO_FLEET.defaultMax, n)),
    });
    if (patch.on !== undefined) auto.on = patch.on;
    if (patch.min !== undefined) {
      auto.min = Math.max(0, Math.min(top, Math.round(patch.min)));
      auto.max = Math.max(auto.max, auto.min);
    }
    if (patch.max !== undefined) {
      auto.max = Math.max(1, Math.min(top, Math.round(patch.max)));
      auto.min = Math.min(auto.min, auto.max);
    }
    delete auto.noMoney;
    delete auto.noRoad;
    // Модернизация: включена — по умолчанию (поля нет), выключена — false; выключили — запас прошлой забывается.
    if (patch.renew !== undefined) {
      if (patch.renew) delete auto.renew;
      else auto.renew = false;
      delete auto.renewSpare;
      delete auto.renewAt;
    }
    this.journal.add('auto', { line: id, on: auto.on, min: auto.min, max: auto.max, ...(auto.renew === false ? { renew: false } : {}) });
    if (!auto.on) {
      delete auto.sell;
      return;
    }
    this.autoBounds(line);
  }

  /**
   * Игрок сам купил или продал машину на линии с авто-парком: пределы раздвигаются под новое число,
   * чтобы авто-парк не отменил его решение. Продал все — авто-парк остаётся включённым, а минимум опускается
   * до 0 (иначе он сразу докупил бы до минимума): линия пустая, машину вернёт спрос (idleDemand) по итогам окна.
   */
  fitAutoRange(lineId: number): void {
    const line = this.lines.get(lineId);
    const auto = line?.auto;
    if (!line || !auto?.on) return;
    const n = line.vehicles.length;
    auto.min = Math.min(auto.min, n);
    auto.max = Math.max(auto.max, n);
    // Решение авто-парка, ждавшее денег (или дороги), устарело: игрок решил сам, спрос считается заново.
    delete auto.noMoney;
    delete auto.noRoad;
    this.restartDemand(line);
  }

  /**
   * Что докупает авто-парк: модель последней купленной машины, подходящей маршруту (грузовой — грузовики,
   * пассажирский — автобусы; смешанный — по станциям), а если такой нет — новейшую подходящую. С модернизацией
   * (renewOn) — новейшую того же вида, что последняя купленная.
   */
  autoModel(line: Line): ModelId {
    const carries = this.lineKind(line) ?? this.stationsCarry(line);
    const last = this.lastVehicle(line, carries);
    // Модернизация включена — докупает уже новейшую модель того же вида.
    if (last) return renewOn(line.auto) ? newestLike(last.model, this.modelOpen) : last.model;
    const freight = carries === 'freight';
    const base: ModelId = this.lineMode(line) === 'rail' ? (freight ? 'freightTrain' : 'passengerTrain') : freight ? 'truck' : 'bus';
    return newestLike(base, this.modelOpen);
  }

  /** Последняя купленная на линию машина, что возит carries. */
  private lastVehicle(line: Line, carries: 'freight' | 'passengers'): FleetVehicle | undefined {
    for (let i = line.vehicles.length - 1; i >= 0; i--) {
      const v = this.fleet.get(line.vehicles[i]);
      if (v && MODELS[v.model].carries === carries) return v;
    }
    return undefined;
  }

  /** Содержание всего транспорта в месяц (списывается непрерывно, accrueUpkeep). */
  private fleetRunning(): number {
    let total = 0;
    for (const v of this.fleet.values()) total += this.runningCost(v);
    return total;
  }

  /**
   * Хватит ли авто-парку денег на следующую машину линии: цена и запас на содержание транспорта за ближайшие
   * полмесяца (ECONOMY.upkeepReserve) — та его часть, что не покроет выручка маршрутов (см. autoFunds).
   */
  autoFunds(line: Line, model: ModelId = this.autoModel(line)): AutoFunds {
    let revenue = 0;
    for (const l of this.lines.values()) revenue += l.revenueLast ?? 0;
    const m = MODELS[model];
    return autoFunds({ money: this.freeMoney, price: m.price, running: this.fleetRunning() + m.running, revenue, window: ECONOMY.upkeepReserve / MONTH_LENGTH });
  }

  /**
   * Какого участка маршрута нет: между какими станциями не проехать по готовой дороге («Нет дороги: А → Б»);
   * null — проехать можно. Проект стройки в движение не входит, пока участок не открыт, — по нему тоже не проехать.
   * Только автомаршруты: у поездов — свои пути и свои проблемы (line.problem).
   */
  lineGap(line: Line): string | null {
    if (this.lineMode(line) !== 'road' || line.stops.length < 2) return null;
    const routes = this.roadLegData(line).routes;
    const i = routes.findIndex((r) => !r);
    if (i < 0) return null;
    const from = this.stations.get(line.stops[i]);
    const to = this.stations.get(line.stops[(i + 1) % line.stops.length]);
    return `Нет дороги: ${from?.name ?? '?'} → ${to?.name ?? '?'}`;
  }

  /**
   * Покупка авто-парком — если до станций маршрута есть дорога (lineGap; нет — ждёт дороги, noRoad) и хватает
   * денег (autoFunds; не хватило — ждёт денег, noMoney).
   */
  private autoBuy(line: Line): boolean {
    const auto = line.auto!;
    if (this.lineGap(line)) {
      auto.noRoad = true;
      delete auto.noMoney;
      return false;
    }
    delete auto.noRoad;
    const model = this.autoModel(line);
    if (!this.autoFunds(line, model).ok) {
      auto.noMoney = true;
      return false;
    }
    const last = this.lastVehicle(line, MODELS[model].carries);
    const v = this.buyVehicle(line.id, model, true);
    // Купить нельзя не из-за денег (модель не подходит маршруту) — ждать денег незачем.
    if (!v) {
      delete auto.noMoney;
      return false;
    }
    // Поезд — той же длины, что и последний такой на линии.
    if (last?.model === model && last.cars !== undefined) v.cars = Math.min(last.cars, this.maxCars(v));
    delete auto.noMoney;
    this.restartDemand(line);
    return true;
  }

  /** Какую машину линии продать игроку («−1 машина» советника): самую незагруженную, лучше стоящую на станции. */
  spareOf(line: Line): FleetVehicle | null {
    return this.spareVehicle(line, true);
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
      this.sellVehicle(v.id, true);
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
   * Итог загрузки линии для авто-парка за окно не короче AUTO_FLEET.window (2 мин) и круга линии — чтобы в него
   * попали рейсы со всех станций и доход за доставку. true — окно закрылось, итог новый.
   */
  private closeDemand(line: Line): boolean {
    const span = this.time - (line.statsFrom ?? 0);
    if (span < Math.max(AUTO_FLEET.window, this.lineLap(line) ?? 0) - 1) return false;
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
    const n = line.vehicles.length;
    // Пустая линия (минимум 0): рейсов нет, загрузку не измерить — машину возвращаем, когда на станциях появится спрос.
    if (!n) {
      if (auto.max > 0 && this.idleDemand(line) >= A.wake) this.autoBuy(line);
      return;
    }
    if (!d) return;
    if (d.load >= A.full && d.left >= A.leftBehind && d.profit >= 0) {
      if (n < auto.max) this.autoBuy(line);
    } else if (auto.low >= A.lowWindows && n > auto.min) {
      auto.sell ??= this.time;
    }
  }

  /**
   * Спрос на линии без машин — для авто-парка: насколько (в долях вместимости машины, которую он купит)
   * загрузилась бы за круг одна машина на самой загруженной остановке. Считает, что уже ждёт отправки этой
   * линией, и что приходило бы за круг: груз предприятий станции, который принимают дальше по маршруту
   * (добыча — сколько предприятие может дать, переработка — сколько выпустило за прошлый месяц; поровну
   * с другими его станциями в маршрутах), и пассажиры до других остановок линии.
   */
  idleDemand(line: Line): number {
    const id = this.autoModel(line);
    const model = MODELS[id];
    const lap = line.lap ?? this.guessLap(line, id) ?? MONTH_LENGTH;
    let best = 0;
    line.stops.forEach((sid, i) => {
      const st = this.stations.get(sid);
      if (!st) return;
      let perLap = 0;
      if (model.carries === 'freight' && st.serves.cargo) {
        const wanted = this.loadable(line, i);
        for (const ind of this.stationIndustries(st)) {
          if (!wanted.has(ind.info.produces)) continue;
          const monthly = ind.info.accepts.length ? ind.producedLast : this.industryRate(ind);
          const others = [...this.stations.values()].filter((o) => o !== st && o.serves.cargo && o.industryIds.includes(ind.id) && this.routed(o));
          perLap += (monthly * lap) / MONTH_LENGTH / (others.length + 1);
        }
      }
      if (model.carries === 'passengers' && st.serves.pax && this.paxPop(st) > 0) {
        const share = this.paxShare(line, sid);
        if (share) perLap += this.paxArrivals(st, lap) * share;
      }
      best = Math.max(best, (this.lineWaiting(line, i, model.carries) + perLap) / model.capacity);
    });
    return best;
  }

  /** Решённая продажа: первая опустевшая машина линии, а не опустела за окно авто-парка — самая незагруженная. */
  private updateAutoSell(): void {
    for (const line of this.lines.values()) {
      const auto = line.auto;
      if (auto?.sell === undefined) continue;
      if (!auto.on || line.vehicles.length <= auto.min) {
        delete auto.sell;
        continue;
      }
      const v = this.spareVehicle(line, this.time - auto.sell > AUTO_FLEET.window);
      if (!v) continue;
      this.sellVehicle(v.id, true);
      delete auto.sell;
      auto.low = 0;
      this.restartDemand(line);
    }
  }

  /**
   * Покупка авто-парка ждёт денег (noMoney): как только их хватает — покупает сразу, не дожидаясь конца
   * окна загрузки, и добирает до минимума. Ждёт дороги (noRoad): дорогу достроили — сразу добирает до минимума.
   */
  private updateAutoWait(): void {
    for (const line of this.lines.values()) {
      const auto = line.auto;
      if (auto?.on && auto.noRoad) {
        if (this.lineGap(line)) continue;
        delete auto.noRoad;
        this.restartDemand(line);
        this.autoBounds(line);
        continue;
      }
      if (!auto?.on || !auto.noMoney) continue;
      if (line.vehicles.length >= auto.max) {
        delete auto.noMoney;
        continue;
      }
      const model = this.autoModel(line);
      if (this.freeMoney < MODELS[model].price || !this.autoFunds(line, model).ok) continue;
      if (this.autoBuy(line)) this.autoBounds(line);
    }
  }

  // ---------- Модернизация в авто-парке ----------

  /**
   * Что модернизации осталось на линии: машины старой модели, которые уже есть на что заменить (кроме заказанных),
   * на какую модель (to; null — менять нечего) и хватит ли денег на следующую замену (funds; null — замен нет).
   */
  renewStatus(line: Line): { old: FleetVehicle[]; to: ModelId | null; funds: AutoFunds | null } {
    const old = line.vehicles.map((id) => this.fleet.get(id)).filter((v): v is FleetVehicle => !!v && !v.upgradeTo && this.replacementFor(v) !== null);
    return { old, to: old.length ? this.replacementFor(old[0]) : null, funds: old.length ? this.renewFunds(old[0]) : null };
  }

  /**
   * Хватит ли авто-парку денег заменить машину на модель новее — как на покупку (autoFunds): доплата (цена новой
   * минус выручка за старую) и запас на содержание за полмесяца — уже с новой вместо старой.
   */
  private renewFunds(v: FleetVehicle): AutoFunds | null {
    const model = this.replacementFor(v);
    if (!model) return null;
    let revenue = 0;
    for (const l of this.lines.values()) revenue += l.revenueLast ?? 0;
    const m = MODELS[model];
    const running = this.fleetRunning() - this.runningCost(v) + this.runningCost({ ...v, model });
    return autoFunds({ money: this.freeMoney, price: m.price - this.saleValue(v), running, revenue, window: ECONOMY.upkeepReserve / MONTH_LENGTH });
  }

  /**
   * Модернизация (renewOn): вышла модель новее того же вида — авто-парк меняет на неё машины линии по одной, не чаще
   * раза в RENEW_GAP, и только свободные — стоящие на станции: на месте (replaceVehicle), линия не останавливается.
   * Денег не хватает (renewFunds) — ждёт. Новые вместительнее: набрался запас на целую старую машину — её продаёт,
   * а не меняет (renewStep). Пока покупка ждёт денег или дороги или решена продажа — не меняет: сначала число машин.
   * Последняя старая заменена — заметка. Проверяет раз в секунду игры.
   */
  private updateAutoRenew(): void {
    if (Math.floor(this.time) === Math.floor(this.time - SIM_DT)) return;
    for (const line of this.lines.values()) {
      const auto = line.auto;
      if (!auto || !renewOn(auto) || auto.noMoney || auto.noRoad || auto.sell !== undefined) continue;
      if (auto.renewAt !== undefined && this.time - auto.renewAt < RENEW_GAP) continue;
      const { old } = this.renewStatus(line);
      if (!old.length) {
        if (auto.renewSpare === undefined) continue;
        delete auto.renewSpare;
        delete auto.renewAt;
        this.notify(`Авто-парк обновил транспорт маршрута «${line.name}»: ${MODELS[this.autoModel(line)].name}`, '#3fae6a', { kind: 'fleet', refs: [{ type: 'line', id: line.id }] });
        continue;
      }
      const cars: RenewCar[] = old.map((v) => ({
        id: v.id,
        capacity: vehicleCapacity(v),
        next: vehicleCapacity({ ...v, model: this.replacementFor(v)! }),
        free: v.state === 'loading' && !v.enter,
        load: vehicleLoad(v),
      }));
      const waited = auto.renewAt !== undefined && this.time - auto.renewAt > AUTO_FLEET.window;
      const step = renewStep({ old: cars, spare: auto.renewSpare ?? 0, count: line.vehicles.length, min: auto.min, waited });
      const v = step && this.fleet.get(step.id);
      const car = step && cars.find((c) => c.id === step.id);
      if (!step || !v || !car) continue;
      const from = v.model;
      if (step.kind === 'sell') {
        this.sellVehicle(v.id, true);
        auto.renewSpare = (auto.renewSpare ?? 0) - car.capacity;
        this.journal.add('renew', { line: line.id, v: v.id, from, sell: true });
      } else {
        if (!this.renewFunds(v)?.ok || !this.replaceVehicle(v.id)) continue;
        auto.renewSpare = (auto.renewSpare ?? 0) + car.next - car.capacity;
        this.journal.add('renew', { line: line.id, v: v.id, from, model: v.upgradeTo ?? v.model });
      }
      auto.renewAt = this.time;
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

  /** model — чем прикидывать, пока на линии нет машин; без него пустой линии — null. */
  private guessLap(line: Line, model?: ModelId): number | null {
    const id = this.fleet.get(line.vehicles[0])?.model ?? model;
    if (!id) return null;
    const m = MODELS[id];
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
    if (v.releaseHold || line.noSpacing) return null;
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
    // Автобус у остановки стоит на дороге: ждать интервала — только в «кармашке» (его объезжают), не загораживая полосу.
    const standing = this.fleetSim(v);
    if (onRoadStop(st) && standing) return this.traffic.standsAside(standing);
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
    delete v.releaseHold;
    return false;
  }

  /** Игрок отправляет машину, которая ждёт интервала за предыдущей, прямо сейчас. */
  dispatchNow(id: number): void {
    const v = this.fleet.get(id);
    if (v && v.holdUntil !== undefined) {
      v.releaseHold = true;
      // Догрузка, пока ждала, — тоже не повод задерживаться: уезжает в ближайший тик.
      v.timer = Math.min(v.timer, 0);
    }
  }

  /** Включает или выключает ожидание интервала на маршруте: выключенный — машины уезжают с первой станции сразу. */
  setLineSpacing(id: number, on: boolean): void {
    const line = this.lines.get(id);
    if (line) line.noSpacing = !on;
  }

  /**
   * Ждёт ли первый рейс маршрута первых пассажиров (firstRun.ts): машина пассажирская, ещё не уезжала с первой
   * станции и стоит на ней, а других машин в работе у линии нет (новая линия или все прежние проданы) —
   * пассажиры здесь только начали появляться.
   */
  private waitsFirstPassengers(v: FleetVehicle, line: Line, st: Station): boolean {
    if (!v.fresh || v.stop !== 0 || MODELS[v.model].carries !== 'passengers') return false;
    if (!line.vehicles.every((id) => this.fleet.get(id)?.fresh)) return false;
    return firstRunWaits(v.waited, vehicleLoad(v), vehicleCapacity(v), this.paxArrivals(st, 1) * this.paxShare(line, st.id));
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
   * auto: пустой грузовик у производителя немного ждёт груз, первый рейс маршрута — первых пассажиров
   * (firstRun.ts); full: до полной загрузки (с пределом ожидания или без); none: сразу в путь.
   */
  private loadingDone(v: FleetVehicle, line: Line, dt: number): boolean {
    // Грузовик ещё едет по двору к рампе получателя: выгрузится, когда встанет (docks.ts → handleStop).
    if (this.docks.entering(v.id)) return false;
    v.timer -= dt;
    if (v.timer > 0) return false;
    const here = this.stations.get(line.stops[v.stop]);
    const model = MODELS[v.model];
    const rule = this.stopRule(line, v.stop);
    const notFull = vehicleLoad(v) < vehicleCapacity(v);
    let wait = false;
    if (here && notFull) {
      if (rule.wait === 'full') wait = rule.maxWait === null || v.waited < rule.maxWait;
      else if (rule.wait === 'auto') wait = model.carries === 'freight' ? v.waited < 25 && this.expectsCargo(here, line, v.stop) : this.waitsFirstPassengers(v, line, here);
    }
    if (here && wait) {
      const moved = model.carries === 'freight' ? this.loadFreight(v, here, line, v.dropped ?? null) : this.boardPassengers(v, here, line);
      v.waited += 1;
      v.timer = 1 + handlingTime(v, moved);
      return false;
    }
    // С первой станции машины уходят с интервалом, а не пачкой; пока ждёт — догружается.
    if (here && this.spacingHold(v, line, here)) {
      const moved = model.carries === 'freight' ? this.loadFreight(v, here, line, v.dropped ?? null) : this.boardPassengers(v, here, line);
      v.timer = 0.5 + handlingTime(v, moved);
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
      // Заказанная замена ждала места на дороге — пробуем снова.
      if (v.upgradeTo) this.applyUpgrade(v);
      const model = MODELS[v.model];
      if (model.mode === 'rail') {
        this.updateTrain(v, line, model, dt);
        continue;
      }
      if (v.state === 'driving' && v.boarding) {
        // Автобус доезжает до места у остановки (центром напротив неё); встал — посадка.
        const sim = this.fleetSim(v);
        const st = this.stations.get(line.stops[v.stop]);
        if (!sim || !st) {
          delete v.boarding;
          continue;
        }
        if (!this.traffic.held(sim)) continue;
        delete v.boarding;
        v.state = 'loading';
        this.handleStop(v, st, line);
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
        this.readyAt.set(v.id, this.time);
        continue;
      }
      if (v.state !== 'departing') continue;
      v.timer -= dt;
      if (v.timer > 0) continue;
      // Уже выезжает со двора получателя — в поток встанет сам (docks.ts → dockHost.joined).
      if (this.docks.leaving(v.id)) continue;
      const from = this.stations.get(line.stops[v.stop]);
      // Следующая — получатель, у которого рампа занята: ждём на этой станции (не дольше RETAIL.rampWait).
      const nextIdx = this.nextStop(v, line);
      if (nextIdx === null) {
        v.timer = 0.5;
        continue;
      }
      const to = this.stations.get(line.stops[nextIdx]);
      if (!from || !to) {
        v.timer = 2;
        continue;
      }
      if (to.kind === 'dock') this.refreshDock(to);
      // Стоит во дворе получателя — выезжает от рампы сам, в просвет (docks.ts).
      if (from.kind === 'dock' && this.docks.inYard(v.id)) {
        const b = this.dockBuilding(from);
        const spec = this.fleetSpec(v, line);
        const endLink = to.kind === 'dock' ? this.dockEndLink(to, v) : undefined;
        if (b && spec && this.docks.leave(v.id, spec, to.nodeId, endLink, b)) {
          this.dockExit.set(v.id, nextIdx);
          continue;
        }
        // Двора больше нет — уезжает от узла станции, как с обычной.
        this.docks.forget(v.id);
      }
      // Автобус стоит у остановки на дороге — едет дальше оттуда же, а не появляется заново.
      const standing = this.fleetSim(v);
      if (standing) {
        if (!this.traffic.continueTo(standing, to.nodeId)) {
          line.problem = `Нет дороги: ${from.name} → ${to.name}`;
          v.timer = 2;
          continue;
        }
        this.traffic.release(standing);
        this.curbSpots.delete(v.id);
        line.problem = null;
        this.recordDeparture(line, v);
        v.state = 'driving';
        v.stop = nextIdx;
        continue;
      }
      const dockB = to.kind === 'dock' ? this.dockBuilding(to) : undefined;
      // К получателю — до связи у его двора (последней в пути): там грузовик свернёт к рампе.
      const route = dockB ? this.docks.route(from.nodeId, dockB, model.spec.length, model.spec.width) : this.roads.route(from.nodeId, to.nodeId);
      if (!route) {
        line.problem = `Нет дороги: ${from.name} → ${to.name}`;
        v.timer = 2;
        continue;
      }
      // У выезда разворачивается техника бригады (crewLoop.ts) — ждёт, как остановленные регулировщиком.
      const gate = this.roads.net.nodes.get(from.nodeId)?.pos;
      if (gate && !this.crewLoops.idle && this.crewLoops.busyAt(gate, model.spec.length)) {
        v.timer = 0.4;
        continue;
      }
      const sim = this.traffic.spawn({
        ...model.spec,
        color: line.color,
        load: v.cargo ? CARGO[v.cargo].color : undefined,
        tank: this.isTanker(v),
        targetNode: to.nodeId,
        route,
      });
      if (sim && dockB) this.docks.approach(sim, v.id, dockB);
      if (!sim) {
        // Выезд занят. После загрузки сохранения отметки готовности нет — ставим с этой минуты.
        if (!this.readyAt.has(v.id)) this.readyAt.set(v.id, this.time);
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
  /**
   * Рейс до этой станции — для журнала: секунд в пути от отправления с прошлой станции, длина пути по дорогам
   * или путям, средняя скорость и сколько простоял в пути (пробки, светофоры). Первое прибытие — пусто.
   */
  private tripStats(v: FleetVehicle, line: Line): Record<string, number> {
    const from = this.departedAt.get(v.id);
    this.departedAt.delete(v.id);
    if (from === undefined || line.stops.length < 2) return {};
    const seconds = this.time - from;
    const prev = (v.stop - 1 + line.stops.length) % line.stops.length;
    const path = this.linePolyline(line, prev);
    let len = 0;
    if (path) for (let i = 1; i < path.length; i++) len += dist(path[i - 1], path[i]);
    const out: Record<string, number> = { trip: seconds };
    if (len > 0) Object.assign(out, { len: Math.round(len), kmh: seconds > 0 ? Math.round((len / seconds) * KMH_PER_UNIT) : 0 });
    const stood = this.stoodOnTrip.get(v.id);
    this.stoodOnTrip.delete(v.id);
    if (stood !== undefined) out.jam = stood;
    return out;
  }

  private recordDeparture(line: Line, v: FleetVehicle): void {
    this.departedAt.set(v.id, this.time);
    this.readyAt.delete(v.id);
    const cap = vehicleCapacity(v);
    const load = vehicleLoad(v) / cap;
    const freight = MODELS[v.model].carries === 'freight';
    const at = this.arrivedAt.get(v.id);
    this.journal.add('go', {
      v: v.id,
      l: line.id,
      st: line.stops[v.stop],
      load: vehicleLoad(v),
      cap,
      cargo: freight ? (v.cargo ?? '—') : 'passengers',
      left: this.lineWaiting(line, v.stop, freight ? 'freight' : 'passengers'),
      wait: at !== undefined ? this.time - at : undefined,
    });
    line.loadSumMonth = (line.loadSumMonth ?? 0) + load;
    line.departuresMonth = (line.departuresMonth ?? 0) + 1;
    const sid = line.stops[v.stop];
    const stats = (line.stopLoads ??= {});
    const s = stats[sid] ?? [0, 0, 0];
    s[0] += load;
    // Осталось ждать — и кто ушёл, не дождавшись, с прошлого отправления линии отсюда: спрос, который она не увезла.
    const since = `${line.id}:${sid}`;
    const gone = this.paxGoneSince.get(since) ?? 0;
    this.paxGoneSince.delete(since);
    s[1] += (this.lineWaiting(line, v.stop, MODELS[v.model].carries) + gone) / cap;
    s[2] += 1;
    stats[sid] = s;
  }

  /**
   * Поезд: грузится на платформе, затем ждёт, пока весь путь до свободной платформы
   * следующего вокзала освободится (автоблокировка), и только тогда отправляется. Все платформы
   * заняты, но с одной поезд уйдёт к нашему приезду (trainLeaving) — отправляется сразу (RailSim.departAhead).
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
        // Не встаёт ни на одну платформу — дело не в очереди, а в длине состава.
        const long = st && this.tooLongText(st, st.platforms, length, model.train.carLength);
        if (long) line.problem = long;
        else if (v.waited > 20) line.problem = `Поезд ждёт свободную платформу: ${st?.name ?? '?'}`;
        return;
      }
      train = this.rail.create({ ...model.train, cars: carsOf(v), color: line.color });
      // Сначала — на путь, выбранный для этой остановки (занят — на любой свободный).
      const own = this.stopPlatform(line, v.stop);
      this.rail.park(train, own !== null ? [own, ...sidingsFirst(st).filter((p) => p !== own)] : sidingsFirst(st));
      this.orientTrain(v, line, train);
      v.trainId = train.id;
      v.waited = 0;
      // Встал на платформу — сначала погрузка; вагоны пока такие, с каким грузом поезд встал.
      v.state = 'loading';
      this.animateWagons(v, train, Infinity);
      this.handleStop(v, st, line);
    }
    train.color = line.color;
    this.animateWagons(v, train, dt);
    if (v.state === 'driving') {
      if ((train.held ?? 0) > 40) {
        const to = this.rail.waitsPlatform(train) ? this.stations.get(line.stops[v.stop]) : undefined;
        line.problem = to
          ? `Поезд долго ждёт у входа на станцию, пока освободится платформа: ${to.name}`
          : 'Поезд долго стоит у красного сигнала. Если на однопутке сигналы в обе стороны — встречные поезда могли упереться друг в друга';
      }
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
    // На путь, выбранный для остановки; авто — на свободный боковой, сквозной остаётся для проходящих поездов
    // (занятые и забронированные платформы маршрут обходит — см. RailSim.findRoute).
    const own = this.stopPlatform(line, nextIdx);
    const targets = own !== null ? [own] : to.platforms;
    const through = own !== null ? undefined : throughOf(to);
    let res = this.rail.depart(train, targets, through);
    // Все платформы заняты, но с одной поезд уйдёт к нашему приезду — едем сейчас и ждём, если что, у входа.
    if (res === 'blocked') res = this.rail.departAhead(train, targets, (t) => this.trainLeaving(t));
    if (res === 'noroute') {
      const k = own !== null ? to.platforms.indexOf(own) + 1 : 0;
      // Состав длиннее платформ следующего вокзала (выбранного пути или всех) — путь есть, встать негде.
      const long = this.tooLongText(to, targets, train.length, train.carLength);
      const short = !!long;
      // Путь есть, но только против сигналов «без встречного» — так и говорим.
      const oneWay = !short && train.platform !== null && this.rail.blockedByOneWay([train.platform], targets, through);
      line.problem = short
        ? own !== null
          ? `Поезд не помещается на путь ${k}: ${to.name}`
          : long
        : `Нет пути: ${from.name} → ${to.name}${k ? `, путь ${k}` : ''}${oneWay ? ' — только против одностороннего сигнала' : ''}`;
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

  /**
   * Поезд, который стоит на платформе или едет к ней (для отправления к ней по прогнозу — RailSim.departAhead):
   * через сколько секунд стоянки он будет готов уехать и к каким платформам следующей станции. null — не знаем:
   * ждёт полной загрузки без предела, первых пассажиров и т. п.
   */
  private trainLeaving(train: Train): Leaving | null {
    const v = this.trainOwner(train);
    const line = v && this.lines.get(v.lineId);
    if (!v || !line || !line.stops.length) return null;
    const after = train.moving ? (v.state === 'driving' ? this.standAhead(v, line) : null) : this.standLeft(v, line);
    if (after === null) return null;
    const next = (v.stop + 1) % line.stops.length;
    const to = this.stations.get(line.stops[next]);
    if (!to) return null;
    const own = this.stopPlatform(line, next);
    return { after, targets: own !== null ? [own] : to.platforms, through: own !== null ? undefined : throughOf(to) };
  }

  /**
   * Сколько ещё секунд поезд простоит на станции до готовности уехать — оценка по условию отправления
   * (loadingDone): текущая погрузка, ожидание груза или полной загрузки с пределом, интервал на первой станции.
   */
  private standLeft(v: FleetVehicle, line: Line): number | null {
    const st = this.stations.get(line.stops[v.stop]);
    if (!st) return null;
    let left = Math.max(0, v.timer);
    if (v.state === 'departing') return left;
    if (v.state !== 'loading') return null;
    const model = MODELS[v.model];
    const rule = this.stopRule(line, v.stop);
    if (vehicleLoad(v) < vehicleCapacity(v)) {
      if (rule.wait === 'full') {
        if (rule.maxWait === null) return null;
        left += Math.max(0, rule.maxWait - v.waited);
      } else if (rule.wait === 'auto') {
        if (model.carries === 'freight' && this.expectsCargo(st, line, v.stop)) left += Math.max(0, 25 - v.waited);
        else if (model.carries !== 'freight' && this.waitsFirstPassengers(v, line, st)) return null;
      }
    }
    const until = v.holdUntil ?? this.spacingUntil(v, line, st);
    if (until !== null) left = Math.max(left, until - this.time);
    return left;
  }

  /**
   * Сколько простоит поезд, который ещё едет к остановке v.stop: выгрузка всего и посадка ждущих (как handleStop),
   * ожидание по условию отправления, на первой станции — интервал. null — без предела (до полной загрузки).
   */
  private standAhead(v: FleetVehicle, line: Line): number | null {
    const st = this.stations.get(line.stops[v.stop]);
    if (!st) return null;
    const model = MODELS[v.model];
    const rule = this.stopRule(line, v.stop);
    const cap = vehicleCapacity(v);
    let left = 2 + handlingTime(v, vehicleLoad(v) + Math.min(cap, this.lineWaiting(line, v.stop, model.carries)));
    if (rule.wait === 'full') {
      if (rule.maxWait === null) return null;
      left += rule.maxWait;
    } else if (rule.wait === 'auto') {
      if (model.carries === 'freight' && this.expectsCargo(st, line, v.stop)) left += 25;
      else if (model.carries !== 'freight' && this.waitsFirstPassengers(v, line, st)) return null;
    }
    if (v.stop === 0 && !line.noSpacing) left = Math.max(left, (this.lineInterval(line) ?? 0) * 0.8);
    return left;
  }

  /**
   * Вагоны на вид догоняют настоящую загрузку: на стоянке наполняются и пустеют в темпе погрузки (грузовые —
   * по очереди, пассажирские — все сразу, во столько раз быстрее), в пути (и при dt = Infinity) — сразу как есть.
   */
  private animateWagons(v: FleetVehicle, train: Train, dt: number): void {
    const cap = vehicleCapacity(v);
    stepWagons(train, vehicleLoad(v) / cap, v.cargo ? CARGO[v.cargo].color : undefined, cap, train.moving ? Infinity : dt, handlingStreams(v));
  }

  /** Выгрузка на остановке закончилась: вагоны поезда сперва пустеют до этой загрузки, потом грузятся. */
  private wagonsUnloaded(v: FleetVehicle): void {
    const train = this.fleetTrain(v);
    if (train && train.fill !== undefined) train.dip = vehicleLoad(v) / vehicleCapacity(v);
  }

  /** Машина или поезд компании по id поезда. */
  trainOwner(train: Train): FleetVehicle | undefined {
    for (const v of this.fleet.values()) if (v.trainId === train.id) return v;
    return undefined;
  }

  private onTrainArrive(train: Train): void {
    // Строительный поезд ж/д проекта (workTrains.ts) — стройка решает сама.
    if (this.construction.trains?.arrive(train)) return;
    const v = this.trainOwner(train);
    const line = v && this.lines.get(v.lineId);
    const st = line && this.stations.get(line.stops[v.stop]);
    if (!v || !line || !st) return;
    v.state = 'loading';
    // Длину состава меняли в пути — перецепляем вагоны на станции.
    this.recouple(v, train);
    this.orientTrain(v, line, train);
    this.handleStop(v, st, line);
  }

  /**
   * Стоящий на остановке v.stop поезд — сразу локомотивом в сторону выезда к следующей остановке линии
   * (RailSim.orient): на погрузке он уже стоит так, как поедет.
   */
  private orientTrain(v: FleetVehicle, line: Line, train: Train): void {
    const n = line.stops.length;
    if (!n || train.moving) return;
    const next = (v.stop + 1) % n;
    const to = this.stations.get(line.stops[next]);
    if (!to) return;
    const own = this.stopPlatform(line, next);
    this.rail.orient(train, own !== null ? [own] : to.platforms, own !== null ? undefined : throughOf(to));
  }

  /** Поезда, стоящие на станциях (в сохранении — и в старой ориентации), — локомотивом к выезду. */
  private orientStandingTrains(): void {
    for (const v of this.fleet.values()) {
      const train = this.fleetTrain(v);
      const line = this.lines.get(v.lineId);
      if (train && line && (v.state === 'loading' || v.state === 'departing')) this.orientTrain(v, line, train);
    }
  }

  private onTrainLost(train: Train): void {
    if (this.construction.trains?.lost(train)) return;
    const v = this.trainOwner(train);
    if (!v) return;
    v.trainId = null;
    const line = this.lines.get(v.lineId);
    if (line) line.problem = 'Путь поезда разобран — поезд вернулся на станцию';
    this.journal.add('lost', { v: v.id, l: v.lineId, train: true });
  }

  /** Машина в потоке — самосвал строительной бригады: id бригады (иначе undefined). */
  crewOfSim(simId: number): number | undefined {
    const owner = this.owners.get(simId);
    return owner?.type === 'crew' ? owner.id : undefined;
  }

  private fleetOf(sim: Vehicle): FleetVehicle | undefined {
    const owner = this.owners.get(sim.id);
    return owner?.type === 'fleet' ? this.fleet.get(owner.id) : undefined;
  }

  /** Машина едет к своей остановке (а не к автостанции) или стоит у неё: у бордюра — подъезжая, смещается к нему заранее. */
  private curbStop(sim: Vehicle): boolean {
    // Машина жителя встаёт напротив заезда к своему гаражу — у бордюра, как перед поворотом во двор.
    if (this.garages.pulls(sim)) return true;
    const v = this.fleetOf(sim);
    const line = v && this.lines.get(v.lineId);
    const st = line && this.stations.get(line.stops[v.stop]);
    if (!v || !st || !onRoadStop(st)) return false;
    // Стоит у неё (доезжает до места или посадка) — уже с маршрутом дальше; едет к ней — она и есть цель.
    return v.state === 'loading' || !!v.boarding || (v.state === 'driving' && st.nodeId === sim.targetNode);
  }

  /**
   * Автобус у остановки — это просто остановка в маршруте: он стоит на дороге (в «кармашке», если есть) у бордюра,
   * его видно и можно выбрать; высадка и посадка — пока стоит, потом едет дальше оттуда же.
   */
  private dwellAt(sim: Vehicle): boolean {
    const v = this.fleetOf(sim);
    const line = v && this.lines.get(v.lineId);
    const st = line && this.stations.get(line.stops[v.stop]);
    if (!v || !line || !st || !onRoadStop(st) || st.nodeId !== sim.targetNode) return false;
    if (st.curb) return this.curbDwell(sim, v, line, st);
    if (v.state === 'driving' && !v.boarding) {
      // Узел остановки — нос автобуса у её середины: проезжает ещё полкорпуса и встаёт центром напротив,
      // уже с маршрутом дальше (посадка начнётся, когда встанет — в updateFleet).
      const next = this.stations.get(line.stops[(v.stop + 1) % line.stops.length]);
      if (next && next.id !== st.id && this.traffic.continueTo(sim, next.nodeId)) {
        this.traffic.holdAfter(sim, sim.length / 2);
        v.boarding = true;
        return true;
      }
      // Дальше дороги нет — встаёт здесь же.
      v.state = 'loading';
      this.handleStop(v, st, line);
    }
    return true;
  }

  /** Куда встал (встаёт) нос автобуса у автовокзала у края улицы: метров от узла станции вдоль мест. */
  private curbSpots = new Map<number, number>();

  /** Вдоль мест автовокзала у края улицы (от узла станции к переднему месту) и сам узел. */
  private curbAxis(st: Station): { node: Vec; dir: Vec } | null {
    const node = this.roads.net.nodes.get(st.nodeId);
    if (!node) return null;
    const u = { x: Math.cos(st.fp.angle), y: Math.sin(st.fp.angle) };
    return { node: node.pos, dir: dot(sub(st.fp.center, node.pos), u) >= 0 ? u : scale(u, -1) };
  }

  /**
   * Автобусы у автовокзала у края улицы: кто встал или встаёт к перрону (посадка, доезжает до места) — нос (м от узла
   * вдоль мест, curbSpots или где он сейчас) и длина.
   */
  private curbOccupants(st: Station, except?: number): { id: number; front: number; length: number }[] {
    const ax = this.curbAxis(st);
    if (!ax) return [];
    const out: { id: number; front: number; length: number }[] = [];
    for (const o of this.fleet.values()) {
      if (o.id === except || (!o.boarding && o.state !== 'loading')) continue;
      const line = this.lines.get(o.lineId);
      const sim = line?.stops[o.stop] === st.id ? this.fleetSim(o) : undefined;
      if (!sim) continue;
      out.push({ id: o.id, front: this.curbSpots.get(o.id) ?? dot(sub(sim.pos, ax.node), ax.dir), length: sim.length });
    }
    return out;
  }

  /**
   * Автобус у узла автовокзала у края улицы (у заднего края мест): есть место у перрона — проезжает к нему, вплотную за
   * последним из стоящих (первый — к самому переднему месту), уже с маршрутом дальше; посадка — когда встанет
   * (updateFleet). Мест нет (все bays заняты или за последним автобус не помещается) — ждёт здесь, у узла: за ним —
   * в крайней полосе улицы, как за автобусом у остановки; у станции — значок «нет мест».
   */
  private curbDwell(sim: Vehicle, v: FleetVehicle, line: Line, st: Station): boolean {
    if (v.state !== 'driving' || v.boarding) return true;
    const ax = this.curbAxis(st);
    if (!ax) return true;
    // Места — вдоль площадки (без её концов): от back до front, м от узла; с кармашком узел — не у самого заднего края.
    const stand = st.fp.w - 2 * STATION.curb.end;
    const mid = dot(sub(st.fp.center, ax.node), ax.dir);
    const back = mid - stand / 2;
    const occ = this.curbOccupants(st, v.id);
    const front = Math.min(mid + stand / 2, ...occ.map((o) => o.front - o.length - IDM.minGap));
    const here = dot(sub(sim.pos, ax.node), ax.dir);
    // Автобус длиннее места (сочленённый, 22 м на месте в 18) — может встать, заехав за край мест назад на свой лишек и
    // ещё метр (не меньше 3 м).
    const over = Math.max(3, sim.length - STATION.curb.berth + 1);
    if (occ.length >= st.bays || front < here || front - sim.length < back - over) {
      if (!this.bayWaitSince.has(v.id)) this.bayWaitSince.set(v.id, this.time);
      return true;
    }
    this.bayWaitSince.delete(v.id);
    const next = this.stations.get(line.stops[(v.stop + 1) % line.stops.length]);
    if (next && next.id !== st.id && this.traffic.continueTo(sim, next.nodeId)) {
      this.traffic.holdAfter(sim, front - here);
      this.curbSpots.set(v.id, front);
      v.boarding = true;
      return true;
    }
    v.state = 'loading';
    this.handleStop(v, st, line);
    return true;
  }

  /**
   * Машина колонны бригады доехала до конца пути (узла подъезда к стройке или узла по дороге): встаёт у конца полосы и
   * ждёт, пока подтянутся остальные — они встают за ней в очередь в потоке, друг за другом, без наложения. Собрались
   * (каждая стоит сразу за предыдущей) — колонна сходит с дороги разом: головная — сейчас, остальные — после шага
   * потока (gatherCrews), каждая там, где стоит; оттуда бригада поедет дальше по своей полосе. Домой на базу — сразу
   * за ворота. Ждёт дольше CREW_WAIT секунд (кто-то застрял) — не держит полосу: доезжает одна.
   *
   * К стройке, где машины сходят по одной (Crews.boarding: участок у подъезда на земле), колонну не собирают: машина
   * сходит на стройку сразу, если все, кто впереди неё по колонне, уже сошли (первая — сразу), и едет к своему месту
   * работ; обогнавшая предыдущую ждёт у конца пути, пока та сойдёт (не дольше CREW_WAIT).
   */
  private crewAssembled(id: number, sim: Vehicle): boolean {
    const crews = this.construction.crews;
    const b = crews.brigades.get(id);
    const cv = b?.convoy;
    if (!b || !cv) return true;
    const base = crews.bases.get(b.base);
    if (b.state === 'back' && base && sim.targetNode === base.nodeId) return true;
    let since = this.crewWaitSince.get(sim.id);
    if (since === undefined) this.crewWaitSince.set(sim.id, (since = this.time));
    if (crews.boarding(b, sim.targetNode)) {
      const k = cv.cars.findIndex((c) => 'sim' in c && c.sim === sim.id);
      if (cv.cars.slice(0, Math.max(0, k)).some((c) => !('at' in c)) && this.time - since < CREW_WAIT) return false;
      this.crewWaitSince.delete(sim.id);
      return true;
    }
    const rest: Vehicle[] = [];
    let ok = true;
    for (const c of cv.cars) {
      if ('at' in c || ('sim' in c && c.sim === sim.id)) continue;
      const o = 'sim' in c ? this.traffic.vehicles.get(c.sim) : undefined;
      if (!o) ok = false;
      else rest.push(o);
    }
    // Очередь: каждая следующая — стоит сразу за предыдущей (нос — не дальше её длины и пары метров).
    let prev = sim;
    for (const o of [...rest].sort((p, q) => dist(p.pos, sim.pos) - dist(q.pos, sim.pos))) {
      if (o.v > 0.5 || dist(o.pos, prev.pos) > prev.length + 6) ok = false;
      prev = o;
    }
    if (!ok && this.time - since < CREW_WAIT) return false;
    this.crewWaitSince.delete(sim.id);
    if (ok) for (const o of rest) this.crewGather.push(o.id);
    return true;
  }

  /** Колонна собралась у конца пути (crewAssembled): машины за головной — с дороги, каждая там, где стоит. */
  private gatherCrews(): void {
    const ids = this.crewGather;
    if (!ids.length) return;
    this.crewGather = [];
    for (const id of ids) {
      const sim = this.traffic.vehicles.get(id);
      const owner = this.owners.get(id);
      const b = owner?.type === 'crew' ? this.construction.crews.brigades.get(owner.id) : undefined;
      if (!sim || !b || !b.convoy || !this.construction.crews.owns(b, id)) continue;
      const at = { node: b.convoy.to, pos: { ...sim.pos }, dir: { ...sim.dir } };
      this.park(id);
      this.construction.crews.arrive(b, at, id);
    }
  }

  private canArrive(sim: Vehicle): boolean {
    const owner = this.owners.get(sim.id);
    if (owner?.type === 'crew') return this.crewAssembled(owner.id, sim);
    const v = this.fleetOf(sim);
    if (!v) return true;
    const line = this.lines.get(v.lineId);
    const st = line && this.stations.get(line.stops[v.stop]);
    const free = !st || st.occupied.length < st.bays;
    if (!free && !this.bayWaitSince.has(v.id)) this.bayWaitSince.set(v.id, this.time);
    return free;
  }

  /** Сколько секунд машина погрузилась и не может выехать со станции (выезд занят); 0 — не ждёт. */
  departWait(v: FleetVehicle): number {
    const at = this.readyAt.get(v.id);
    return at !== undefined && v.state === 'departing' && v.simId === null ? this.time - at : 0;
  }

  /** Сколько секунд машина стоит у станции и ждёт свободный пост; 0 — не ждёт. */
  bayWait(v: FleetVehicle): number {
    const at = this.bayWaitSince.get(v.id);
    return at !== undefined && v.state === 'driving' && v.simId !== null ? this.time - at : 0;
  }

  /**
   * Кто ждёт въезда на станции: машина, которой не дали поста (bayWait), и стоящие за ней на подъезде;
   * поезд, который не может уехать, потому что все платформы следующего вокзала заняты (или встать на свою).
   */
  private approaches(): Approach[] {
    const out: Approach[] = [];
    for (const v of this.fleet.values()) {
      const line = this.lines.get(v.lineId);
      if (!line) continue;
      if (MODELS[v.model].mode === 'rail') {
        // Уехал по прогнозу, а платформа ещё занята — стоит у входа на станцию.
        const train = v.state === 'driving' ? this.fleetTrain(v) : undefined;
        if (train && this.rail.waitsPlatform(train)) {
          out.push({ station: line.stops[v.stop], line: line.id, blocked: true, stopped: true, dist: 0 });
          continue;
        }
        if (v.state !== 'departing' || v.waited <= 0) continue;
        // Поезд на платформе ждёт путь к следующему вокзалу; без поезда — ждёт платформу на своём.
        const next = v.trainId != null ? (v.stop + 1) % line.stops.length : v.stop;
        const to = this.stations.get(line.stops[next]);
        if (!to || to.kind !== 'rail') continue;
        const own = v.trainId != null ? this.stopPlatform(line, next) : null;
        const targets = own !== null ? [own] : to.platforms;
        if (targets.length && targets.every((p) => this.rail.isReserved(p))) out.push({ station: to.id, line: line.id, blocked: true, stopped: true, dist: 0 });
        continue;
      }
      const sim = v.state === 'driving' ? this.fleetSim(v) : undefined;
      const st = sim && this.stations.get(line.stops[v.stop]);
      const gate = st && this.roads.net.nodes.get(st.nodeId);
      // У автовокзала у края улицы автобус, что проезжает к своему месту, уже не ждёт.
      if (!sim || !st || st.kind !== 'road' || !gate || v.boarding) continue;
      out.push({ station: st.id, line: line.id, blocked: this.bayWait(v) > 0, stopped: sim.v < 0.5, dist: dist(sim.pos, gate.pos) });
    }
    return out;
  }

  /** Раз в полсекунды: где все посты (платформы) заняты и сколько ждут въезда — для значка «нет мест» и подсказок. */
  private updateJams(dt: number): void {
    this.jamClock -= dt;
    if (this.jamClock > 0) return;
    this.jamClock = 0.5;
    const list = this.approaches();
    const ids = new Set([...list.map((a) => a.station), ...this.jams.keys()]);
    for (const id of ids) {
      const st = this.stations.get(id);
      const full =
        !!st &&
        (st.kind === 'rail'
          ? st.platforms.every((p) => this.rail.isReserved(p))
          : st.curb
            ? list.some((a) => a.station === st.id && a.blocked)
            : st.occupied.length >= st.bays);
      const jam = nextJam(this.jams.get(id), full, queuedAt(list, id), this.time);
      if (jam) this.jams.set(id, jam);
      else this.jams.delete(id);
    }
  }

  /** Сколько машин (поездов) ждут въезда на станцию, где все посты (платформы) заняты; 0 — очереди нет или она недолгая. */
  stationJam(st: Station): number {
    const jam = this.jams.get(st.id);
    return jamShown(jam, this.time) ? jam.waiting : 0;
  }

  /** Станции, у которых машины линии стоят в очереди на въезд (все посты заняты), и сколько там ждут всего. */
  lineJams(line: Line): { station: Station; waiting: number }[] {
    const out: { station: Station; waiting: number }[] = [];
    for (const [id, jam] of this.jams) {
      const st = this.stations.get(id);
      if (st && jamShown(jam, this.time) && jam.lines.includes(line.id)) out.push({ station: st, waiting: jam.waiting });
    }
    return out;
  }

  private onArrive(sim: Vehicle): void {
    const owner = this.owners.get(sim.id);
    this.owners.delete(sim.id);
    if (owner?.type === 'citizen') {
      this.citizenCars--;
      this.garages.forget(sim.id);
      this.curb.forget(sim.id);
      // Доехала до узла ворот большой площадки — встаёт на место (LotParking.arrive).
      this.lots.arrive(sim);
      this.parkSearch.forget(sim.id);
      this.carHomes.arrived(sim.id);
      return;
    }
    if (owner?.type === 'service') {
      this.serviceCars--;
      return;
    }
    if (owner?.type === 'crew') {
      const crew = this.construction.crews.brigades.get(owner.id);
      if (crew && this.construction.crews.owns(crew, sim.id)) this.construction.crews.arrive(crew, { node: sim.targetNode, pos: sim.pos, dir: sim.dir }, sim.id);
      return;
    }
    const v = owner && this.fleet.get(owner.id);
    if (!v) return;
    v.simId = null;
    this.bayWaitSince.delete(v.id);
    const line = this.lines.get(v.lineId);
    const st = line && this.stations.get(line.stops[v.stop]);
    if (!line || !st) {
      v.state = 'departing';
      v.timer = 1;
      return;
    }
    // Для журнала: сколько машина простояла в пути (пробки, светофоры, перекрёстки).
    this.stoodOnTrip.set(v.id, sim.stoppedTime);
    // Получатель: доехал до узла за его двором, не свернув (не успел остановиться, дорогу поменяли) — заезжает снова.
    if (st.kind === 'dock') {
      this.dockMissed(v, st, line);
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
    return nearestBay(this.bayArea(st), st.bays, taken, p);
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
      this.parkSearch.forget(sim.id);
      this.garages.forget(sim.id);
      this.curb.forget(sim.id);
      this.lots.forget(sim.id, true);
      this.carHomes.arrived(sim.id);
      return;
    }
    if (owner?.type === 'service') {
      this.serviceCars--;
      return;
    }
    if (owner?.type === 'crew') {
      const crew = this.construction.crews.brigades.get(owner.id);
      if (crew && this.construction.crews.owns(crew, sim.id)) this.construction.crews.lost(crew);
      return;
    }
    const v = owner && this.fleet.get(owner.id);
    if (!v) return;
    const line = this.lines.get(v.lineId);
    v.simId = null;
    v.state = 'departing';
    v.timer = 2;
    this.bayWaitSince.delete(v.id);
    this.readyAt.delete(v.id);
    if (line) {
      // Машина возвращается на предыдущую станцию и пробует снова.
      v.stop = (v.stop - 1 + line.stops.length) % line.stops.length;
      line.problem = 'Машина потеряла дорогу и вернулась на станцию';
    }
    this.journal.add('lost', { v: v.id, l: v.lineId, back: line?.stops[v.stop] });
  }

  private handleStop(v: FleetVehicle, st: Station, line: Line): void {
    const model = MODELS[v.model];
    let moved = 0;
    let revenue = 0;
    // Наибольшая надбавка за скорость среди доставленного — для подписи над станцией.
    let bonus = 0;
    v.dropped = null;
    // Рейс в журнал: что выгрузили и кому, что погрузили, сколько заплатили, сколько ехали и простояли.
    const trip: Record<string, unknown> = { v: v.id, l: line.id, st: st.id, i: v.stop, ...this.tripStats(v, line) };
    this.arrivedAt.set(v.id, this.time);
    if (model.carries === 'freight') {
      const what = v.cargo ? this.unloadsHere(line, v.stop, st, v.cargo) : null;
      if (v.cargo && what === 'deliver' && v.loadedAt !== st.id) {
        // Платят за расстояние от станции, где груз впервые погрузили (с учётом пересадок).
        const origin = v.loadedAt !== null ? this.stations.get(v.loadedAt) : undefined;
        const distance = origin ? dist(origin.fp.center, st.fp.center) : 0;
        const k = v.fromStore || v.loadedTime === undefined ? 1 : this.speedFactor(distance, this.time - v.loadedTime);
        const cargo = v.cargo;
        const loadedAt = v.loadedAt;
        // Получатели принимают, сколько влезает на склад (world/retail.ts): платят только за принятое, остальное едет
        // дальше по маршруту. Предприятие и город по старой модели — всё.
        const parts = this.deliver(st, cargo, v.amount);
        const took = parts.reduce((n, p) => n + p.amount, 0);
        // Откуда груз: предприятие у станции первой погрузки, которое его производит.
        const maker = origin?.industryIds.find((id) => this.industries.find((i) => i.id === id)?.info.produces === cargo);
        if (took > 0) {
          bonus = Math.max(bonus, k);
          revenue += Math.round((took * CARGO[cargo].rate * ECONOMY.tariff * distance * k * this.mods.price(cargo)) / 100);
          for (const p of parts) {
            this.scenario?.onDelivered(cargo, p.amount, p.to, k, maker);
            this.ideas.onDelivered(cargo, p.amount, p.to, k, maker);
          }
          moved += took;
          this.carried(line, v, took);
          v.dropped = cargo;
          v.amount -= took;
          if (v.amount <= 0) {
            v.cargo = null;
            v.amount = 0;
            v.loadedAt = null;
          }
        } else {
          // Склады получателей полны: груз едет дальше — над станцией серый значок «некуда».
          this.floaters.push({ pos: { ...st.fp.center }, text: '📦⛔', color: '#7a7f88', age: 0 });
          trip.full = true;
        }
        const to = parts[0]?.to;
        Object.assign(trip, { drop: { [cargo]: took }, to: to ? `${to.type}:${to.id}` : 'никому', from: loadedAt, x: k });
      } else if (v.cargo && what === 'store') {
        // Склад: выгружаем столько, сколько поместится; дальше груз повезёт другая линия.
        const c = v.cargo;
        const take = Math.min(v.amount, this.stationFree(st));
        if (take > 0) {
          st.cargo[c] = (st.cargo[c] ?? 0) + take;
          st.cargoOrigin = { ...st.cargoOrigin, [c]: v.loadedAt ?? st.id };
          v.amount -= take;
          moved += take;
          v.dropped = c;
          trip.store = { [c]: take };
          if (v.amount <= 0) {
            v.cargo = null;
            v.amount = 0;
            v.loadedAt = null;
          }
        }
      }
      // Груз остался в кузове: здесь его не принимают — видно, если маршрут настроен не так.
      if (v.cargo && v.amount > 0) {
        trip.keep = { [v.cargo]: v.amount };
        this.noteKept(v, st, line, what);
      } else if (st.kind !== 'dock' && !v.dropped) this.retailNotes.back.delete(line.id);
      this.wagonsUnloaded(v);
      const taken = this.loadFreight(v, st, line, v.dropped);
      if (taken > 0 && v.cargo) trip.take = { [v.cargo]: taken };
      if (st.serves.cargo) trip.wait = this.lineWaiting(line, v.stop, 'freight');
      moved += taken;
    } else {
      const stay = [];
      // Станция у предприятия, которому не хватает рабочих: довезённые — его рабочие, проезд им не оплачивается.
      const workers = this.enterprises.takesWorkers(st);
      let crew = 0;
      for (const g of v.passengers) {
        if (g.to !== st.id) {
          stay.push(g);
          continue;
        }
        const from = this.stations.get(g.from);
        if (workers) {
          crew += g.count;
          moved += g.count;
          this.carried(line, v, g.count);
          this.scenario?.onPassengers(from?.townIds[0], undefined, g.count, 1);
          this.ideas.onPassengers(from?.townIds[0], undefined, g.count, 1);
          continue;
        }
        const distance = from ? dist(from.fp.center, st.fp.center) : 0;
        const k = g.at === undefined ? 1 : this.speedFactor(distance, this.time - g.at);
        bonus = Math.max(bonus, k);
        // Билет за посадку и тариф за прямую с долей объезда по остановкам линии (game/fare.ts).
        const path = line.stops[v.stop] === st.id ? ridePath(line.stops, (id) => this.stations.get(id)?.fp.center, g.from, v.stop) : null;
        revenue += Math.round(paxFare(g.count, distance, path, k) * this.mods.price('passengers'));
        moved += g.count;
        this.carried(line, v, g.count);
        this.scenario?.onPassengers(from?.townIds[0], st.townIds[0], g.count, k);
        this.ideas.onPassengers(from?.townIds[0], st.townIds[0], g.count, k);
        const town = st.townIds.length ? this.towns.find((t) => t.id === st.townIds[0]) : undefined;
        if (town) town.growthAcc += g.count * 0.02;
        // Довезённые — в счёт города отправления: блок «Что нужно городу» (world/townPax.ts).
        const home = from?.townIds.length ? this.towns.find((t) => t.id === from.townIds[0]) : undefined;
        if (home) addTownPax(home, town?.id ?? PAX_NOWHERE, g.count);
      }
      v.passengers = stay;
      if (crew > 0) {
        this.enterprises.addCrew(st, crew);
        trip.crew = crew;
        this.floaters.push({ pos: { ...st.fp.center }, text: `👷 +${crew}`, color: '#8a6d1f', age: 0 });
      }
      this.wagonsUnloaded(v);
      if (moved > 0) Object.assign(trip, { off: moved, x: bonus });
      // Сколько мест у машины линии, когда она приходит сюда: по ним пассажиры решают, ждать ли (paxPatience.ts).
      if (st.serves.pax) {
        const key = `${line.id}:${st.id}`;
        const free = Math.max(0, vehicleCapacity(v) - vehicleLoad(v));
        const was = this.paxSeats.get(key);
        this.paxSeats.set(key, was === undefined ? free : was + (free - was) * PAX_WAIT.seatsEma);
      }
      const boarded = this.boardPassengers(v, st, line);
      if (boarded > 0) trip.on = boarded;
      trip.wait = this.lineWaiting(line, v.stop, 'passengers');
      moved += boarded;
    }
    if (revenue > 0) trip.pay = revenue;
    this.journal.add('stop', trip);
    if (revenue > 0) {
      this.earn(revenue, line, v);
      // Быстрая доставка оплачивается дороже — показываем множитель рядом с суммой.
      const fast = bonus >= 1.1 ? ` ⚡×${bonus.toFixed(1)}` : bonus > 0 && bonus <= 0.9 ? ` 🐢×${bonus.toFixed(1)}` : '';
      this.floaters.push({ pos: { ...st.fp.center }, text: `+$${revenue.toLocaleString('ru-RU')}${fast}`, color: '#2e9d57', age: 0 });
    }
    // Пассажирский поезд сажает и высаживает через все вагоны сразу — стоит во столько раз короче. У рампы получателя —
    // по выгруженному (RETAIL.unloadBase + unloadPer за единицу).
    v.timer = st.kind === 'dock' ? unloadTime(moved) : 2 + handlingTime(v, moved);
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
      if (auto && n < auto.max) return;
      const fix = auto ? 'поднимите максимум авто-парка' : 'купите ещё';
      const waiting = Math.floor(this.lineWaiting(line, i));
      const gone = this.lineGone(line, i);
      if (waiting >= 150) out.push(`${st.name}: ждут отправки ${waiting} — не хватает транспорта, ${fix}`);
      else if (gone >= 60) out.push(`${st.name}: за месяц ${gone} не дождались и ушли пешком — не хватает транспорта, ${fix}`);
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
    if (what !== 'passengers' && st.serves.cargo) {
      const near = this.transferSources(line, index);
      for (const c of this.loadable(line, index)) {
        waiting += st.cargo[c] ?? 0;
        for (const o of near) waiting += transferable(o, c);
      }
    }
    return waiting;
  }

  /**
   * Сколько пассажиров до других остановок линии ушло с её остановки index, не дождавшись (paxPatience.ts):
   * за этот месяц или прошлый — что больше.
   */
  lineGone(line: Line, index: number): number {
    const st = this.stations.get(line.stops[index]);
    if (!st) return 0;
    let now = 0;
    let last = 0;
    for (const dest of new Set(line.stops)) {
      if (dest === st.id) continue;
      now += st.paxGone?.[dest] ?? 0;
      last += st.paxGoneLast?.[dest] ?? 0;
    }
    return Math.max(now, last);
  }

  /**
   * Соседние станции, с которых маршрут на остановке index забирает груз перевалкой (src/game/transfer.ts):
   * грузовые рядом с ней, кроме станций самого маршрута — иначе он перекладывал бы свой же груз туда-обратно.
   */
  transferSources(line: Line, index: number): Station[] {
    const st = this.stations.get(line.stops[index]);
    if (!st?.serves.cargo) return [];
    return transferNeighbors(st, this.stations.values()).filter((o) => !line.stops.includes(o.id));
  }

  /**
   * Перевалка у станции st для карточки: какой груз со склада какой соседней станции заберут маршруты другой
   * (from → to). Соседи без перевалки — с пустым списком: видно, что рядом есть с кем перекладывать.
   */
  transferFlows(st: Station): { near: Station; flows: { from: Station; to: Station; cargo: CargoType; amount: number; lines: Line[] }[] }[] {
    if (!st.serves.cargo) return [];
    return transferNeighbors(st, this.stations.values()).map((near) => {
      const flows: { from: Station; to: Station; cargo: CargoType; amount: number; lines: Line[] }[] = [];
      for (const [from, to] of [
        [near, st],
        [st, near],
      ]) {
        for (const c of FREIGHT) {
          // Только груз, который сюда уже выгружали на склад (сейчас его может и не быть): продукцию не перекладывают.
          const origin = from.cargoOrigin?.[c];
          if (origin === undefined || origin === from.id) continue;
          const amount = transferable(from, c);
          const lines = [...this.lines.values()].filter(
            (l) => !l.stops.includes(from.id) && l.stops.some((sid, i) => sid === to.id && this.loadable(l, i).has(c)),
          );
          if (lines.length) flows.push({ from, to, cargo: c, amount, lines });
        }
      }
      return { near, flows };
    });
  }

  stopRule(line: Line, index: number): StopRule {
    return line.rules?.[index] ?? DEFAULT_RULE;
  }

  /** Путь ж/д станции, выбранный для остановки index (id платформы); null — авто: любой свободный. */
  stopPlatform(line: Line, index: number): number | null {
    const k = this.stopRule(line, index).platform;
    const st = this.stations.get(line.stops[index]);
    if (k === undefined || k === null || st?.kind !== 'rail' || k < 0 || k >= st.platforms.length) return null;
    return st.platforms[k];
  }

  /** Путь линии от остановки i до следующей — для отрисовки: по выбранным платформам, если они заданы. */
  linePolyline(line: Line, i: number): Vec[] | null {
    const j = (i + 1) % line.stops.length;
    const from = this.stations.get(line.stops[i]);
    const to = this.stations.get(line.stops[j]);
    if (from?.kind === 'rail' || to?.kind === 'rail') return this.routePolyline(line.stops[i], line.stops[j], this.stopPlatform(line, i), this.stopPlatform(line, j));
    return this.roadLegs(line)[i] ?? null;
  }

  /**
   * Линия дорожного маршрута по участкам — как едут сами машины: от остановки на улице дальше за её узел в ту же
   * сторону, а не разворотом в нём (путь участка зависит от того, как приехали на предыдущем); автобусы — правее.
   */
  private roadLegs(line: Line): (Vec[] | null)[] {
    return this.roadLegData(line).legs;
  }

  /**
   * Участки дорожного маршрута (roadLegs): связи графа и линия для карты — по версии сети, остановкам и дворам
   * получателей. Как едут грузовики (docks.ts): к получателю — до связи у его двора, от него — со двора на полосу
   * и дальше по ходу через узел станции. Иначе участок кончался бы в узле станции, а следующий начинался из него,
   * и поворота в узле не было бы ни в одном — линия на карте рвалась на перекрёстке у магазина.
   */
  private roadLegData(line: Line): { routes: (number[] | null)[]; legs: (Vec[] | null)[] } {
    const version = this.net.version * 100003 + this.roads.net.version;
    const keepRight = this.lineKind(line) === 'passengers';
    const n = line.stops.length;
    const stop = (i: number) => this.stations.get(line.stops[((i % n) + n) % n]);
    // Двор — для грузовика маршрута (как dockEndLink), пока их нет — для того, что купят.
    const model = this.chartModel(line);
    const spec = model && MODELS[model].mode === 'road' ? MODELS[model].spec : undefined;
    const yards = line.stops.map((_, i) => {
      const st = stop(i);
      const b = st?.kind === 'dock' ? this.dockBuilding(st) : undefined;
      const geo = b ? this.docks.geoOf(b, spec?.length, spec?.width) : null;
      return geo?.in && geo.out && geo.in.link.toNode !== null ? { in: geo.in.link.id, node: geo.in.link.toNode, out: geo.out.lane.link } : null;
    });
    const key = `${version}|${line.stops.join(',')}|${keepRight}|${yards.map((y) => (y ? `${y.in}>${y.out}` : '')).join(',')}`;
    const hit = this.legCache.get(line.id);
    if (hit?.key === key) return hit;
    const routes = line.stops.map((_, i) => {
      const a = stop(i);
      const b = stop(i + 1);
      if (!a || !b) return null;
      const from = yards[i];
      const to = yards[(i + 1) % n];
      const starts = from ? [from.out] : (this.roads.graph.outLinks.get(a.nodeId) ?? []).map((l) => l.id);
      const real = from || to ? this.roads.routeFrom(starts, to ? to.node : b.nodeId, to?.in) : null;
      // Двора не подъехать — как машина без двора: от узла станции к узлу.
      return real ?? this.roads.route(a.nodeId, b.nodeId);
    });
    // Два прохода: по кругу первый участок тоже продолжает последний.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const prev = routes[(i - 1 + n) % n];
        const to = stop(i + 1);
        if (stop(i)?.kind !== 'stop' || !to || !prev?.length) continue;
        const yard = yards[(i + 1) % n];
        const cont = this.roads.continueRoute(prev[prev.length - 1], yard ? yard.node : to.nodeId, yard?.in);
        if (cont) routes[i] = cont;
      }
    }
    const legs = routes.map((r) => (r ? this.roads.routePolyline(r, keepRight) : null));
    const data = { key, routes, legs };
    this.legCache.set(line.id, data);
    return data;
  }

  /**
   * Модель, по которой считать график скорости линии: первой машины маршрута, а пока их нет — новейшая из
   * тех, что продаются для маршрута (по виду транспорта и тому, что он возит).
   */
  private chartModel(line: Line): ModelId | null {
    const v = line.vehicles.map((id) => this.fleet.get(id)).find((x) => x);
    if (v) return v.model;
    const kind = this.lineKind(line);
    const models = modelsFor(this.lineMode(line), this.modelOpen).filter((m) => !kind || MODELS[m].carries === kind);
    return models[models.length - 1] ?? null;
  }

  /**
   * График скорости круга линии (А→Б→…→А): пределы по пути (знаки, изгибы, перекрёстки, уклоны) и скорость
   * её транспорта по свободной дороге, с разгоном от каждой остановки и торможением к ней. null — какого-то
   * участка нет или купить для маршрута пока нечего.
   */
  lineSpeedChart(line: Line): SpeedChart | null {
    const id = this.chartModel(line);
    if (!id || line.stops.length < 2) return null;
    const m = MODELS[id];
    const plats = line.stops.map((_, i) => this.stopPlatform(line, i));
    const key = `${this.net.version}|${this.roads.net.version}|${this.terrain.version}|${line.stops.join(',')}|${plats.join(',')}|${this.lineKind(line)}|${id}`;
    const hit = this.speedChartCache.get(line.id);
    if (hit?.key === key) return hit.chart;
    let legs: (TrackPiece[] | null)[];
    let motion: Motion;
    if (m.mode === 'rail') {
      const t = m.train;
      legs = line.stops.map((sid, i) => {
        const j = (i + 1) % line.stops.length;
        const from = this.stations.get(sid);
        const to = this.stations.get(line.stops[j]);
        if (from?.kind !== 'rail' || to?.kind !== 'rail') return null;
        // Как линия на карте (routePolyline): с выбранных платформ, иначе — с боковых путей.
        const starts = plats[i] !== null ? [plats[i]!] : sidingsFirst(from).slice(0, Math.max(1, from.platforms.length - 1));
        const goal = plats[j] !== null ? [plats[j]!] : to.platforms;
        return this.rail.previewTrack(starts, goal, plats[j] !== null ? undefined : throughOf(to));
      });
      // Как поезд в симуляции: в подъём медленнее, чем круче склон.
      motion = { top: (g) => t.maxSpeed * (g > 0 ? Math.max(0.35, 1 - Math.min(1, g / GRADE.rail) * 0.5) : 1), accel: () => t.accel, decel: t.brake };
    } else {
      const s = m.spec;
      const heavy = s.kind !== 'car';
      legs = this.roadLegData(line).routes.map((r) => (r ? this.roads.routeTrack(r) : null));
      // Как машина в симуляции: на уклоне — gradeFactor, тяжёлые в гору ещё и разгоняются хуже.
      motion = { top: (g) => s.maxSpeed * gradeFactor(g, heavy), accel: (g) => s.accel * (g > 0 && heavy ? Math.max(0.35, 1 - 6 * g) : 1), decel: IDM.brake / 2 };
    }
    const chart = legs.every((l): l is TrackPiece[] => !!l?.length) ? speedChart(legs.map((pieces) => ({ pieces })), motion) : null;
    this.speedChartCache.set(line.id, { key, chart });
    return chart;
  }

  /** Что делать с грузом на остановке: доставить получателю, оставить на складе или везти дальше. */
  private unloadsHere(line: Line, index: number, st: Station, cargo: CargoType): 'deliver' | 'store' | null {
    if (!st.serves.cargo) return null;
    const rule = this.stopRule(line, index);
    const listed = rule.unload === 'all' || (Array.isArray(rule.unload) && rule.unload.includes(cargo));
    // Оптовая база — склад-пересадка: всё, что просит город, — на её склад (платят, когда развозка довезёт до магазина).
    if (st.kind === 'dock' && this.isDepotDock(st)) return st.accepts.has(cargo) && (rule.unload === 'auto' || listed) ? 'store' : null;
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
  loadable(line: Line, index: number): Set<CargoType> {
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
   * Сначала — со своей станции; нечего взять (или есть место) — перевалкой со склада соседней станции
   * (transferSources: груз, который туда выгрузила другая линия), той же станции первой погрузки.
   */
  private loadFreight(v: FleetVehicle, st: Station, line: Line, skip: CargoType | null = null): number {
    if (!st.serves.cargo) return 0;
    const wanted = this.loadable(line, v.stop);
    const sources = [st, ...this.transferSources(line, v.stop)];
    // Своя станция отдаёт всё, соседняя — только привезённое на её склад другой линией.
    const avail = (s: Station, c: CargoType) => (s === st ? (s.cargo[c] ?? 0) : transferable(s, c));
    const originOf = (s: Station, c: CargoType) => s.cargoOrigin?.[c] ?? s.id;
    let best: CargoType | null = v.cargo;
    let origin = v.cargo ? v.loadedAt : null;
    if (!best) {
      for (const s of sources) {
        for (const c of FREIGHT) {
          if (c === skip || !wanted.has(c) || avail(s, c) < 1) continue;
          if (!best || avail(s, c) > avail(s, best)) best = c;
        }
        if (best) {
          origin = originOf(s, best);
          break;
        }
      }
    }
    if (!best || !wanted.has(best)) return 0;
    let total = 0;
    for (const s of sources) {
      if (originOf(s, best) !== origin) continue;
      const take = Math.floor(Math.min(vehicleCapacity(v) - v.amount, avail(s, best)));
      if (take <= 0) continue;
      s.cargo[best] = (s.cargo[best] ?? 0) - take;
      v.cargo = best;
      v.amount += take;
      total += take;
      // Время доставки считаем от первой погрузки; со склада — без надбавки за скорость.
      if (v.amount === take) {
        v.loadedTime = this.time;
        v.fromStore = origin !== st.id;
      }
      v.loadedAt = origin;
    }
    return total;
  }

  private earn(amount: number, line: Line, v: FleetVehicle): void {
    this.money += amount;
    this.incomeMonth += amount;
    this.ledger.transport += amount;
    line.revenueMonth += amount;
    line.revenueTotal += amount;
    v.profitMonth += amount;
  }

  /**
   * Груз — получателю у станции: заводу на склад или городу в снабжение. Кто сколько принял: завод и город по старой
   * модели — всё (одной частью; to — null, если никто: как прежде, кузов отдаётся «никому»). С получателями
   * (world/retail.ts) — каждый в охвате до своего склада, сначала самые пустые; потребность без получателей в городе —
   * по-старому, всё. Никто не принял — пусто.
   */
  private deliver(st: Station, cargo: CargoType, amount: number): { to: Ref | null; amount: number }[] {
    const ind = st.kind === 'dock' ? undefined : this.industries.find((i) => st.industryIds.includes(i.id) && i.info.accepts.includes(cargo));
    if (ind) {
      ind.stock[cargo] = (ind.stock[cargo] ?? 0) + amount;
      this.industryRev++;
      return [{ to: { type: 'industry', id: ind.id }, amount }];
    }
    if (!this.retail) {
      const town = this.towns.find((t) => st.townIds.includes(t.id) && t.demands.includes(cargo));
      if (town) town.supplied[cargo] = (town.supplied[cargo] ?? 0) + amount;
      return [{ to: town ? { type: 'town', id: town.id } : null, amount }];
    }
    const near = this.stationReceivers(st).filter((x) => x.r.cargo.includes(cargo));
    if (near.length) {
      // Сначала тем, у кого склад пустее: груз расходится по магазинам, а не в ближайший до отказа.
      near.sort((a, b) => stockFill(a.town, a.r, cargo, this.time) - stockFill(b.town, b.r, cargo, this.time) || a.r.b - b.r.b);
      const by = new Map<number, number>();
      let left = Math.floor(amount);
      for (const { town, r } of near) {
        if (left <= 0) break;
        const took = acceptAt(town, r, cargo, left, this.time);
        if (took <= 0) continue;
        left -= took;
        by.set(town.id, (by.get(town.id) ?? 0) + took);
      }
      if (!by.size) return [{ to: { type: 'town', id: near[0].town.id }, amount: 0 }];
      return [...by].map(([id, n]) => ({ to: { type: 'town', id }, amount: n }));
    }
    if (st.kind === 'dock') return [];
    // Потребность без получателей (топливо в городе, где АЗС ещё нет): по-старому, любая станция с домами города в охвате.
    const town = this.towns.find((t) => st.townIds.includes(t.id) && legacyCargo(t).includes(cargo));
    if (!town) return [];
    town.supplied[cargo] = (town.supplied[cargo] ?? 0) + amount;
    return [{ to: { type: 'town', id: town.id }, amount }];
  }

  // ---------- Получатели грузов (world/retail.ts, docs/RETAIL.md) ----------

  /** Город принимает груз через получателей — магазины, рынок, конторы, склады (новые партии, WorldSettings.retail). */
  get retail(): boolean {
    return retailOn(this.settings);
  }

  /**
   * Для советника (advisor.ts), только партии с получателями; не сохраняется. kept — маршрут привёз груз на станцию в
   * городе, которому он нужен, а там его не принимают (в охвате нет магазинов с ним): последний раз — где, что, когда.
   * back — грузовик вернулся на станцию погрузки с грузом, не сдав его: все магазины маршрута полны (сколько раз подряд).
   */
  readonly retailNotes = {
    kept: new Map<number, { st: number; cargo: CargoType; amount: number; at: number }>(),
    back: new Map<number, { cargo: CargoType; n: number; at: number }>(),
  };

  /** Груз остался в кузове на остановке st (what — что с ним делали здесь): отметки для советника (retailNotes). */
  private noteKept(v: FleetVehicle, st: Station, line: Line, what: 'deliver' | 'store' | null): void {
    if (!this.retail || !v.cargo || what !== null || st.kind === 'dock' || !st.serves.cargo) return;
    const cargo = v.cargo;
    if (v.loadedAt !== st.id) {
      // Город просит этот груз, а станция его не берёт: возят «в город», как раньше, — надо в магазины.
      if (this.towns.some((t) => st.townIds.includes(t.id) && t.demands.includes(cargo)))
        this.retailNotes.kept.set(line.id, { st: st.id, cargo, amount: v.amount, at: this.time });
      return;
    }
    // Вернулся туда, где грузили, почти полным, а на маршруте есть кому сдать: магазины полны — машин больше, чем надо.
    const sells = line.stops.some((id) => this.stations.get(id)?.accepts.has(cargo));
    if (!sells || v.amount < vehicleCapacity(v) * 0.5) {
      this.retailNotes.back.delete(line.id);
      return;
    }
    const was = this.retailNotes.back.get(line.id);
    this.retailNotes.back.set(line.id, { cargo, n: (was?.n ?? 0) + 1, at: this.time });
  }

  /** Грузовик у рампы получателя ждёт на прошлой остановке, пока она не освободится: с какого времени. */
  private rampWaitSince = new Map<number, number>();
  /** Грузовик выезжает со двора получателя: к какой остановке маршрута поедет. */
  private dockExit = new Map<number, number>();
  /** Сколько раз грузовик проехал мимо двора и заезжает снова (не больше двух — дальше пропускает получателя). */
  private dockTries = new Map<number, number>();

  /** Что разворотам техники бригад петлёй (crewLoop.ts) нужно от игры. */
  private crewLoopHost(): CrewLoopHost {
    const game = this;
    return {
      get traffic() {
        return game.traffic;
      },
      get graph() {
        return game.roads.graph;
      },
      get time() {
        return game.time;
      },
      crewSims: () => {
        const out: Vehicle[] = [];
        for (const b of this.construction.crews.brigades.values()) {
          for (const c of b.convoy?.cars ?? []) {
            const v = 'sim' in c ? this.traffic.vehicles.get(c.sim) : undefined;
            if (v) out.push(v);
          }
        }
        return out;
      },
      parked: () => {
        const crews = this.construction.crews;
        const out: BodyLook[] = [];
        for (const b of crews.brigades.values()) for (const m of crews.carsAt(b)) out.push({ ...this.crewCar(b, m.car), pos: m.pos, dir: m.dir });
        return out;
      },
      area: (center, r) => {
        const near = this.index.near(center, r + 80);
        const rails = this.net.segmentsNear(center, r + 20);
        return {
          roads: this.roads.net.corridorsNear(center, r + 30),
          blocked: (fp) => {
            const corners = footprintCorners(fp);
            if (!this.inBounds(fp.center, 5) || this.isWater(fp.center, 0.5) || corners.some((q) => this.isWater(q, 0.5))) return true;
            // Станция — с площадкой перед постами (въезд, разворотная «шляпка» тупика у ворот): там заезжают на посты.
            if (near.some((s) => footprintsOverlap(fp, s.fp, s.type === 'station' ? LOOP.yard : 0.5))) return true;
            if (this.lotUnder(fp, 0.5) || this.parkUnder(fp, null)) return true;
            return rails.some((s) => [fp.center, ...corners].some((q) => s.lut.closest(q).d < halfWidth(s.spec) + 0.5));
          },
        };
      },
    };
  }

  /** Что дворам получателей (docks.ts) нужно от игры. */
  private dockHost(): DockHost {
    const game = this;
    return {
      get traffic() {
        return game.traffic;
      },
      get graph() {
        return game.roads.graph;
      },
      get net() {
        return game.roads.net;
      },
      lotBusy: (b) => this.shops.lotBusy(b),
      gone: (id, sim) => {
        // Кузов ушёл с полосы во двор: в потоке грузовика нет, он — на остановке (к рампе ещё едет).
        this.owners.delete(sim.id);
        const v = this.fleet.get(id);
        if (!v) return;
        v.simId = null;
        v.state = 'loading';
        v.timer = 1;
        this.bayWaitSince.delete(v.id);
        this.stoodOnTrip.set(v.id, sim.stoppedTime);
      },
      arrived: (id) => {
        const v = this.fleet.get(id);
        const line = v && this.lines.get(v.lineId);
        const st = line && this.stations.get(line.stops[v.stop]);
        if (!v || !line || st?.kind !== 'dock') return;
        this.dockTries.delete(id);
        this.handleStop(v, st, line);
      },
      joined: (id, sim) => {
        const v = this.fleet.get(id);
        const line = v && this.lines.get(v.lineId);
        if (!v || !line) {
          this.traffic.remove(sim);
          return;
        }
        const next = this.dockExit.get(id) ?? (v.stop + 1) % line.stops.length;
        this.dockExit.delete(id);
        this.owners.set(sim.id, { type: 'fleet', id: v.id });
        v.simId = sim.id;
        line.problem = null;
        this.recordDeparture(line, v);
        v.state = 'driving';
        v.stop = next;
        const to = this.stations.get(line.stops[next]);
        if (to?.kind === 'dock') {
          const b = this.dockBuilding(to);
          if (b) this.docks.approach(sim, v.id, b);
        }
      },
    };
  }

  /**
   * Получатели города заново (в начале партии и в конце месяца): по населению и потребностям; те, к кому ездят
   * маршруты, остаются (world/retail.pickReceivers). Охват станций в городе — заново: что они теперь принимают.
   */
  refreshReceivers(town: Town): void {
    if (!this.retail) return;
    const keep = this.routedReceivers(town);
    const fish = this.industries.some((i) => !i.ruin && i.info.produces === 'fish');
    town.receivers = pickReceivers(town, this.time, keep, (b) => this.docks.reachable(b, maxTruck(b)), { fish });
    for (const st of this.stations.values()) if (st.townIds.includes(town.id) || st.dock?.town === town.id) this.computeCatchment(st);
  }

  /** Дома-получатели города, к которым ездят маршруты (их станции у двора — в линиях). */
  private routedReceivers(town: Town): Set<number> {
    const keep = new Set<number>();
    for (const st of this.stations.values()) if (st.kind === 'dock' && st.dock?.town === town.id && this.stationLines(st.id).length) keep.add(st.dock.b);
    return keep;
  }

  /**
   * АЗС и оптовая база в городе (world/retail.zoneRetail; только партии с получателями): в начале новой партии — из
   * любых подходящих домов, при росте — только из новых (fresh). Получателей в маршрутах не трогает.
   */
  private zoneRetailTown(town: Town, fresh?: ReadonlySet<number>): void {
    if (!this.retail) return;
    if (fresh && !fresh.size) return;
    zoneRetail(town, { score: (b, kind) => this.retailSiteScore(town, b, kind), keep: this.routedReceivers(town), fresh });
  }

  /**
   * Пригодность дома под АЗС или оптовую базу: к сквозному двору подъедет Фура (21 м); АЗС — на улице, что уводит за
   * город (выезд) или к трассе, на проспекте, у края застройки; база — у магистрали (ближе к ней — лучше), на участке не
   * уже DEPOT_MIN_W. Не подходит — null.
   */
  private retailSiteScore(town: Town, b: TownBuilding, kind: 'fuel' | 'depot'): number | null {
    if (kind === 'depot' && b.fp.w < DEPOT_MIN_W) return null;
    const probe: TownBuilding = { ...b, form: kind };
    if (!this.docks.reachable(probe, RETAIL.maxLength.yard)) return null;
    const net = this.roads.net;
    const front = lotFrame(b)(0, -b.fp.h / 2 - LOT_SETBACK);
    let street: Corridor | null = null;
    let sd = Infinity;
    for (const c of net.corridorsNear(front, 40)) {
      const d = c.lut.closest(front).d;
      if (d < sd) {
        sd = d;
        street = c;
      }
    }
    if (!street) return null;
    const big = (c: Corridor) => c.cls === 'highway' || c.cls === 'motorway';
    const wide = street.cls === 'avenue' || big(street);
    const far = Math.max(dist(net.node(street.a).pos, town.center), dist(net.node(street.b).pos, town.center));
    const exit = far > town.radius * 1.05 || nearHighway(net, street, this.drivewayIds());
    const edge = edgeOf(town, b.fp.center);
    if (kind === 'fuel') return (exit ? 3 : 0) + (wide ? 2 : 0) - Math.abs(edge - 0.85);
    let hw = 400;
    for (const c of net.corridorsNear(b.fp.center, 400)) if (big(c) || !this.streetLike(c)) hw = Math.min(hw, c.lut.closest(b.fp.center).d);
    return (exit ? 2 : 0) + (wide ? 1 : 0) - hw / 100 - Math.abs(edge - 0.9);
  }

  /** Получатели в охвате станции (у станции у получателя — он сам): город, запись получателя, дом. */
  stationReceivers(st: Station): { town: Town; r: Receiver; b: TownBuilding }[] {
    const out: { town: Town; r: Receiver; b: TownBuilding }[] = [];
    if (!this.retail) return out;
    if (st.kind === 'dock') {
      const town = st.dock && this.towns.find((t) => t.id === st.dock!.town);
      const r = town && receiverOf(town, st.dock!.b);
      const b = r && town.buildings.find((x) => x.id === r.b);
      if (town && r && b) out.push({ town, r, b });
      return out;
    }
    if (!st.serves.cargo) return out;
    const R = this.catchmentRadius(st);
    for (const town of this.towns) {
      if (!st.townIds.includes(town.id) || !town.receivers?.length) continue;
      const byId = new Map(town.buildings.map((b) => [b.id, b]));
      for (const r of town.receivers) {
        // Оптовая база — склад-пересадка, а не потребитель: станция рядом ей не сдаёт.
        if (r.depot) continue;
        const b = byId.get(r.b);
        if (b && dist(b.fp.center, st.fp.center) <= R) out.push({ town, r, b });
      }
    }
    return out;
  }

  /**
   * Склад оптовой базы (дом b): насколько полон (0…1 от RETAIL.depotStock) и какого груза больше всего; станции у
   * базы ещё нет — пусто.
   */
  depotStock(b: number): { fill: number; top: CargoType | null; stored: number; cargo: Partial<Record<CargoType, number>> } {
    for (const st of this.stations.values()) {
      if (st.kind !== 'dock' || st.dock?.b !== b) continue;
      const stored = this.stationStored(st);
      const top = FREIGHT.filter((c) => (st.cargo[c] ?? 0) >= 1).sort((x, y) => (st.cargo[y] ?? 0) - (st.cargo[x] ?? 0))[0] ?? null;
      return { fill: Math.min(1, stored / RETAIL.depotStock), top, stored, cargo: st.cargo };
    }
    return { fill: 0, top: null, stored: 0, cargo: {} };
  }

  /** Станция у оптовой базы (склад-пересадка, world/retail.Receiver.depot). */
  isDepotDock(st: Station): boolean {
    if (st.kind !== 'dock' || !st.dock) return false;
    const town = this.towns.find((t) => t.id === st.dock!.town);
    return !!(town && receiverOf(town, st.dock.b)?.depot);
  }

  /** Получатель под точкой p (дом-магазин, рынок, контора, склад из подобранных): город, запись, дом. */
  receiverAt(p: Vec): { town: Town; r: Receiver; b: TownBuilding } | null {
    if (!this.retail) return null;
    const s = this.index.at(p, 2);
    if (s?.type !== 'building') return null;
    const town = this.towns.find((t) => t.id === s.townId);
    const r = town && receiverOf(town, s.id);
    return town && r ? { town, r, b: s } : null;
  }

  /** Дом станции у получателя. */
  dockBuilding(st: Station): TownBuilding | undefined {
    if (!st.dock) return undefined;
    return this.towns.find((t) => t.id === st.dock!.town)?.buildings.find((b) => b.id === st.dock!.b);
  }

  /** Название получателя-дома b: вид и город, при нескольких получателях одного вида — с номером («Магазин 2, Каменка»). */
  dockName(b: TownBuilding): string {
    const town = this.towns.find((t) => t.id === b.townId);
    const form = formOf(b);
    const same = (town?.receivers ?? []).filter((x) => {
      const o = town!.buildings.find((y) => y.id === x.b);
      return o && formOf(o) === form;
    });
    const n = same.length > 1 ? ` ${same.findIndex((x) => x.b === b.id) + 1}` : '';
    return `${FORM_NAMES[form]}${n}, ${town?.name ?? ''}`;
  }

  /** Станция у получателя-дома b: есть — она, нет — новая, невидимая (kind 'dock'); дом — не получатель — null. */
  dockFor(b: TownBuilding): Station | null {
    const town = this.towns.find((t) => t.id === b.townId);
    const r = town && receiverOf(town, b.id);
    if (!town || !r) return null;
    for (const st of this.stations.values()) if (st.kind === 'dock' && st.dock?.b === b.id) return st;
    const st: Station = {
      type: 'station',
      id: this.nextId(),
      kind: 'dock',
      dock: { town: town.id, b: b.id },
      name: this.dockName(b),
      fp: { ...b.fp },
      nodeId: this.docks.nodeOf(b, maxTruck(b)) ?? -1,
      platforms: [],
      serves: { pax: false, cargo: true },
      industryId: null,
      cargo: {},
      passengers: new Map(),
      occupied: [],
      bays: 1,
      townIds: [town.id],
      industryIds: [],
      accepts: new Set(),
      catchPop: 0,
      paxAcc: 0,
    };
    this.stations.set(st.id, st);
    this.computeCatchment(st);
    this.journal.add('dock', { st: st.id, b: b.id, town: town.id });
    return st;
  }

  /**
   * Станции у получателей, которых нет ни в одном маршруте (кроме keep — их ещё прокладывают): убрать. Станция у
   * оптовой базы с грузом на складе остаётся: груз не пропадает, пока маршрут к базе прокладывают заново.
   */
  pruneDocks(keep: readonly number[] = []): void {
    for (const st of [...this.stations.values()]) {
      if (st.kind !== 'dock' || keep.includes(st.id) || this.stationLines(st.id).length) continue;
      if (this.stationStored(st) >= 1 && this.isDepotDock(st)) continue;
      this.stations.delete(st.id);
      this.journal.add('dock-', { st: st.id });
    }
  }

  /**
   * Что везёт маршрут по станциям stops — для «🛒 все магазины с этим грузом»: продукция предприятий у его станций,
   * которую принимают магазины, иначе груз на складе оптовой базы маршрута, иначе то, что берёт уже стоящий в нём
   * магазин. Ничего — null.
   */
  shopCargo(stops: readonly number[]): CargoType | null {
    if (!this.retail) return null;
    const sts = stops.map((id) => this.stations.get(id)).filter((s): s is Station => !!s);
    const taken = (c: CargoType) => this.towns.some((t) => t.receivers?.some((r) => !r.depot && r.cargo.includes(c)));
    for (const st of sts) if (st.serves.cargo && st.kind !== 'dock') for (const ind of this.stationIndustries(st)) if (taken(ind.info.produces)) return ind.info.produces;
    for (const st of sts) {
      if (!this.isDepotDock(st)) continue;
      const c = FREIGHT.filter((x) => (st.cargo[x] ?? 0) >= 1 && taken(x)).sort((a, b) => (st.cargo[b] ?? 0) - (st.cargo[a] ?? 0))[0];
      if (c) return c;
    }
    for (const st of sts) for (const { r } of this.stationReceivers(st)) if (!r.depot && r.cargo[0]) return r.cargo[0];
    return null;
  }

  /**
   * «🛒 все магазины с этим грузом» (редактор маршрута): получатели груза cargo одного города, которых ещё нет среди
   * stops, — по порядку ближайшего соседа от последней остановки. Город — тот, чей магазин уже в маршруте, иначе —
   * ближайший к последней остановке. Грузовику длины L (самый длинный на маршруте) не влезть во двор или не подъехать —
   * мимо. Только расчёт: станции у них ставит addShopStops.
   */
  shopTargets(stops: readonly number[], cargo: CargoType, L?: number): TownBuilding[] {
    if (!this.retail) return [];
    const sts = stops.map((id) => this.stations.get(id)).filter((s): s is Station => !!s);
    const inLine = new Set(sts.filter((s) => s.kind === 'dock').map((s) => s.dock!.b));
    const last = sts[sts.length - 1]?.fp.center;
    if (!last) return [];
    const shopsOf = (t: Town) =>
      (t.receivers ?? [])
        .filter((r) => !r.depot && r.cargo.includes(cargo) && !inLine.has(r.b))
        .map((r) => t.buildings.find((x) => x.id === r.b))
        // Узел станции у двора — по самому длинному грузовику, что туда заезжает (dockFor): к нему тоже подъехать.
        .filter(
          (b): b is TownBuilding =>
            !!b && this.docks.reachable(b, maxTruck(b)) && (L === undefined || (L <= maxTruck(b) + 1e-6 && this.docks.reachable(b, L))),
        );
    // Город, чей магазин с этим грузом уже в маршруте, — он (все его магазины уже в нём — добавлять нечего).
    const docked = this.towns.find(
      (t) => sts.some((s) => s.kind === 'dock' && s.dock!.town === t.id) && t.receivers?.some((r) => !r.depot && r.cargo.includes(cargo) && inLine.has(r.b)),
    );
    const towns = docked ? [docked] : this.towns.filter((t) => shopsOf(t).length);
    if (!towns.length) return [];
    const near = (t: Town) => Math.min(...shopsOf(t).map((b) => dist(b.fp.center, last)));
    const town = docked ?? towns.sort((a, b) => near(a) - near(b) || a.id - b.id)[0];
    const left = shopsOf(town);
    const out: TownBuilding[] = [];
    let at = last;
    while (left.length) {
      let k = 0;
      for (let i = 1; i < left.length; i++) if (dist(left[i].fp.center, at) < dist(left[k].fp.center, at) - 1e-9) k = i;
      const b = left.splice(k, 1)[0];
      out.push(b);
      at = b.fp.center;
    }
    return out;
  }

  /** Самый длинный грузовик маршрута (у ещё не купленных — нет): по нему — какие дворы годятся. */
  lineTruckLength(line: Line): number | undefined {
    let L: number | undefined;
    for (const id of line.vehicles) {
      const m = MODELS[this.fleet.get(id)?.model ?? 'truck'];
      if (m.mode === 'road' && m.carries === 'freight') L = Math.max(L ?? 0, m.spec.length);
    }
    return L;
  }

  /**
   * «🛒 все магазины с этим грузом» в маршрут line (или в прокладываемый — stops без line): станции у магазинов
   * (shopTargets) — в конец, по порядку. Возвращает id станций; маршрут не принял — пусто.
   */
  addShopStops(stops: readonly number[], line?: Line): number[] {
    const cargo = this.shopCargo(stops);
    if (!cargo) return [];
    const ids: number[] = [];
    for (const b of this.shopTargets(stops, cargo, line ? this.lineTruckLength(line) : undefined)) {
      const st = this.dockFor(b);
      if (st) ids.push(st.id);
    }
    if (!line || !ids.length) return ids;
    const rules = line.rules ?? line.stops.map(() => null);
    const problem = this.setLineRoute(line.id, [...line.stops, ...ids], [...rules, ...ids.map(() => null)]);
    if (problem) {
      this.pruneDocks();
      return [];
    }
    this.journal.add('shops+', { l: line.id, c: cargo, st: ids });
    return ids;
  }

  /** Узел станции у получателя — по нынешней сети (за двором по ходу полосы); не подъехать — −1. */
  private refreshDock(st: Station): void {
    const b = this.dockBuilding(st);
    if (b) st.fp = { ...b.fp };
    st.nodeId = (b && this.docks.nodeOf(b, maxTruck(b))) ?? -1;
  }

  /** Последняя связь пути грузовика v к получателю to (с неё он свернёт во двор). */
  private dockEndLink(to: Station, v: FleetVehicle): number | undefined {
    const b = this.dockBuilding(to);
    const m = MODELS[v.model];
    return b && m.mode === 'road' ? this.docks.geoOf(b, m.spec.length, m.spec.width)?.in?.link.id : undefined;
  }

  /** Грузовик в потоке (из сохранения) едет к получателю: путь — до связи у двора, там свернёт. */
  private dockApproach(sim: Vehicle, v: FleetVehicle, st: Station): void {
    const b = this.dockBuilding(st);
    const route = b && this.docks.routeFrom(sim, b);
    if (!b || !route || !this.traffic.redirect(sim, st.nodeId, route)) return;
    this.docks.approach(sim, v.id, b);
  }

  /** Как нарисовать и пустить в поток грузовик v: кузов модели, цвет линии, груз. */
  private fleetSpec(v: FleetVehicle, line: Line): VehicleSpec | null {
    const m = MODELS[v.model];
    if (m.mode !== 'road') return null;
    return { ...m.spec, color: line.color, load: v.cargo ? CARGO[v.cargo].color : undefined, tank: this.isTanker(v) };
  }

  /**
   * Почему грузовик v не едет к получателю st: длинный для двора, не подъехать, рампа занята (другой грузовик во дворе
   * или сворачивает к нему); null — едет.
   */
  private dockRefusal(v: FleetVehicle, st: Station): 'long' | 'reach' | 'busy' | 'pax' | null {
    const m = MODELS[v.model];
    if (m.carries !== 'freight' || m.mode !== 'road') return 'pax';
    const b = this.dockBuilding(st);
    if (!b) return 'reach';
    if (m.spec.length > maxTruck(b) + 1e-6) return 'long';
    if (!this.docks.reachable(b, m.spec.length, m.spec.width)) return 'reach';
    // Рампы (у рынка две) заняты, пока другие грузовики во дворе или уже сворачивают к ним (docks.rampBusy).
    if (this.docks.rampBusy(b, v.id, m.spec.length, m.spec.width)) return 'busy';
    return null;
  }

  /**
   * Следующая остановка машины v после нынешней: получатель (dock), к которому грузовику не подъехать или он не
   * влезет во двор, — пропускается; рампа занята — машина ждёт (null), а дольше RETAIL.rampWait — тоже пропускает.
   */
  private nextStop(v: FleetVehicle, line: Line): number | null {
    const n = line.stops.length;
    // Первый получатель, которому везти нечего (кузов пуст, склад полон), — на случай, если дальше заехать некуда.
    let idle: number | null = null;
    for (let k = 1; k < n; k++) {
      const i = (v.stop + k) % n;
      const st = this.stations.get(line.stops[i]);
      if (!st || st.kind !== 'dock') {
        this.rampWaitSince.delete(v.id);
        return i;
      }
      if (this.dockIdle(v, line, i, st)) {
        // Магазину везти нечего — мимо, не заезжая во двор (заезд — с полминуты): развозка по тем, где есть место.
        if (!this.dockRefusal(v, st)) idle ??= i;
        continue;
      }
      const why = this.dockRefusal(v, st);
      if (!why) {
        this.rampWaitSince.delete(v.id);
        return i;
      }
      if (why === 'busy') {
        let since = this.rampWaitSince.get(v.id);
        if (since === undefined) this.rampWaitSince.set(v.id, (since = this.time));
        if (this.time - since < RETAIL.rampWait) return null;
        this.journal.add('skip', { v: v.id, l: line.id, st: st.id, why });
      } else {
        const text = why === 'long' ? `${st.name}: грузовик не влезет во двор` : why === 'reach' ? `${st.name}: к двору не подъехать` : `${st.name}: автобусы к магазинам не ездят`;
        if (line.problem !== text) this.journal.add('skip', { v: v.id, l: line.id, st: st.id, why });
        line.problem = text;
      }
      this.rampWaitSince.delete(v.id);
    }
    // Везти некуда, кроме получателей, которым сейчас нечего везти, — к первому из них, по порядку маршрута.
    if (idle !== null) this.rampWaitSince.delete(v.id);
    return idle;
  }

  /**
   * Грузовику v на остановке i (станция у получателя st) везти нечего: кузов пуст, в нём то, чего получатель не берёт,
   * или на складе места меньше RETAIL.worthVisit склада (и весь остаток кузова не влезет) — заезд во двор дольше, чем
   * стоят крохи. Оптовая база — не мимо (там и грузят), и остановка с правилом выгрузки или погрузки — тоже: так её
   * настроил игрок.
   */
  private dockIdle(v: FleetVehicle, line: Line, i: number, st: Station): boolean {
    if (!this.retail || this.isDepotDock(st)) return false;
    const rule = this.stopRule(line, i);
    if (rule.unload !== 'auto' || rule.load !== 'auto') return false;
    // В кузове крохи — сперва догрузиться: заезд ради одной-двух единиц дольше, чем они того стоят.
    if (!v.cargo || v.amount < Math.max(1, vehicleCapacity(v) * RETAIL.crumbs)) return true;
    const at = this.stationReceivers(st)[0];
    if (!at) return true;
    // Место на складе — за вычетом того, что уже везут туда другие грузовики (едут к этому магазину).
    const room = roomFor(at.town, at.r, v.cargo, this.time) - this.dockIncoming(st, v);
    if (room < 1) return true;
    return room < Math.floor(v.amount) && room < stockCap(at.town, at.r, v.cargo) * RETAIL.worthVisit;
  }

  /** Сколько груза уже везут к получателю st другие грузовики (едут к нему или заезжают во двор, ещё не сдав). */
  private dockIncoming(st: Station, except: FleetVehicle): number {
    let n = 0;
    for (const w of this.fleet.values()) {
      if (w === except || !w.cargo || w.amount <= 0 || w.state === 'departing') continue;
      if (this.lines.get(w.lineId)?.stops[w.stop] !== st.id) continue;
      // Уже у рампы и сдал — не в счёт (state 'loading' после выгрузки: кузов уже легче).
      if (w.state === 'loading' && this.docks.inYard(w.id) && !this.docks.entering(w.id)) continue;
      n += w.amount;
    }
    return n;
  }

  /**
   * Грузовик доехал до узла за двором получателя, не свернув (проехал мимо, правили дорогу, из сохранения): заезжает
   * снова — в объезд, путь кончается связью у двора. Дважды не вышло (или не подъехать) — пропускает получателя и
   * едет дальше от узла.
   */
  private dockMissed(v: FleetVehicle, st: Station, line: Line): void {
    const tries = this.dockTries.get(v.id) ?? 0;
    const b = this.dockBuilding(st);
    const m = MODELS[v.model];
    // Рампа была занята — круг по кварталу и снова (не больше двух раз).
    const why = this.dockRefusal(v, st);
    const route = b && m.mode === 'road' && tries < 2 && (!why || why === 'busy') ? this.docks.route(st.nodeId, b, m.spec.length, m.spec.width) : null;
    const spec = route && this.fleetSpec(v, line);
    const sim = route && spec ? this.traffic.spawn({ ...spec, targetNode: st.nodeId, route }) : null;
    if (sim && b) {
      this.dockTries.set(v.id, tries + 1);
      this.owners.set(sim.id, { type: 'fleet', id: v.id });
      v.simId = sim.id;
      this.docks.approach(sim, v.id, b);
      return;
    }
    this.dockTries.delete(v.id);
    this.journal.add('skip', { v: v.id, l: line.id, st: st.id, why: 'missed' });
    v.state = 'departing';
    v.timer = 0.5;
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
    return Math.max(20, Math.min(what === 'freight' ? this.stationStorage(st) : STATION.cargoCap, capacity * 2));
  }

  /** Склад станции: сколько груза всех видов может на ней лежать — база, пристройки и склады-здания (STORAGE). */
  stationStorage(st: Station): number {
    if (st.kind === 'rail') return STORAGE.rail;
    // Оптовая база: её склад — RETAIL.depotStock.
    if (st.kind === 'dock' && this.isDepotDock(st)) return RETAIL.depotStock;
    return STORAGE.base + storageSlots(st) * STORAGE.per;
  }

  /** Сколько груза всех видов лежит на станции. */
  stationStored(st: Station): number {
    let n = 0;
    for (const c of FREIGHT) n += st.cargo[c] ?? 0;
    return n;
  }

  /** Свободного места на складе станции. */
  stationFree(st: Station): number {
    return Math.max(0, this.stationStorage(st) - this.stationStored(st));
  }

  /** Склад станции почти полон — продукции некуда класть, завод не растёт. */
  stationFull(st: Station): boolean {
    return this.stationStored(st) >= this.stationStorage(st) * 0.95;
  }

  private updateIndustries(dt: number): void {
    for (const ind of this.industries) {
      // Заброшенное и строящееся не работает (режим «Строит игрок»).
      if (!isActive(ind)) continue;
      // Продукция идёт на станции в маршрутах, даже пока машин на них нет (lineTakes).
      const served = [...this.stations.values()].filter((st) => st.serves.cargo && st.industryIds.includes(ind.id) && this.routed(st));
      const inputs = ind.info.accepts;
      // Уровень производства, временный множитель событий сценария, рабочие и богатство месторождения (enterprises.ts).
      const level = (ind.level ?? 1) * this.mods.industry(ind.id) * this.enterprises.rateFactor(ind);
      if (!inputs.length) {
        if (served.length) ind.prodAcc += (ind.info.rate * level * dt) / MONTH_LENGTH;
      } else {
        // Переработка идёт, только когда есть все виды сырья; выросший завод перерабатывает больше.
        const available = Math.min(...inputs.map((c) => ind.stock[c] ?? 0));
        const conv = Math.min(available, (ECONOMY.processRate * level * dt) / MONTH_LENGTH);
        if (conv > 0) {
          for (const c of inputs) ind.stock[c] = (ind.stock[c] ?? 0) - conv;
          ind.prodAcc += conv;
          this.industryRev++;
        }
      }
      const whole = Math.floor(ind.prodAcc);
      if (whole > 0) {
        ind.prodAcc -= whole;
        ind.output += whole;
        ind.producedMonth += whole;
        this.industryRev++;
        // Построенное в партии считает выпуск с постройки — для заданий «построить и выпустить».
        if (ind.builtBy) ind.made = (ind.made ?? 0) + whole;
      }
      if (ind.output >= 1 && served.length) {
        const per = Math.floor(ind.output / served.length);
        for (const st of served) {
          const c = ind.info.produces;
          // Не больше, чем есть места на складе станции (все грузы вместе) и чем предел по транспорту.
          st.cargo[c] = Math.min(this.stationCap(st, 'freight'), (st.cargo[c] ?? 0) + Math.min(per, this.stationFree(st)));
        }
        ind.output -= per * served.length;
      }
      ind.output = Math.min(ind.output, 300);
      // Сколько времени за месяц продукция копилась у предела станции — транспорт не успевал (для роста).
      const c = ind.info.produces;
      if (served.some((st) => (st.cargo[c] ?? 0) >= this.stationCap(st, 'freight') * 0.9 || this.stationFull(st))) ind.piledMonth = (ind.piledMonth ?? 0) + dt;
    }
  }

  /**
   * Куда со станции может уехать пассажир: станция назначения → пассажирские линии (lineTakes): где ходят
   * автобусы или пассажирские поезда, а пока машин нет — маршрут пассажирский по своим станциям. Пассажиры
   * начинают ждать, как только маршрут проложен. Грузовики пассажиров не берут.
   */
  paxRoutes(st: Station): Map<number, Line[]> {
    const out = new Map<number, Line[]>();
    if (!st.serves.pax) return out;
    // Между половинами одной пары никто не ездит: это одна остановка через улицу.
    const mate = st.pair !== undefined ? this.pairOf(st)?.id : undefined;
    for (const line of this.lines.values()) {
      if (!line.stops.includes(st.id) || !this.lineTakes(line, 'passengers')) continue;
      for (const sid of line.stops) {
        // Пассажиры едут только на станции, которые работают с пассажирами.
        if (sid === st.id || sid === mate || !this.stations.get(sid)?.serves.pax) continue;
        const list = out.get(sid) ?? [];
        if (!list.includes(line)) list.push(line);
        out.set(sid, list);
      }
    }
    return out;
  }

  /** Сколько пассажиров появляется на станции за dt секунд (когда им есть куда ехать). */
  private paxArrivals(st: Station, dt: number): number {
    // У пары — жители обеих половин: поток один на пару (updateStations — у первой по номеру).
    const town = st.townIds.length ? st.townIds[0] : this.pairOf(st)?.townIds[0];
    return (this.paxPop(st) / 1000) * PAX_PER_THOUSAND * dt * (town !== undefined ? this.mods.pax(town) : 1);
  }

  /** Насколько охотно пассажиры едут на эту станцию: по жителям в её охвате (у пары — у обеих половин). */
  private paxWeight(sid: number): number {
    const st = this.stations.get(sid);
    return (st ? this.paxPop(st) : 0) + 60;
  }

  /** Станция назначения как направление: у пары остановок — одно на обе половины (по меньшему номеру). */
  private paxKey(sid: number): number {
    const mate = this.pairOf(this.stations.get(sid));
    return mate ? Math.min(sid, mate.id) : sid;
  }

  /**
   * Куда едут пассажиры, что появляются у станции st: по направлению (paxKey) — станция, где выйдут, где ждут
   * автобуса (at) и вес направления. У пары остановок (и до пары) из двух половин — та, откуда ехать по линии
   * ближе (rideAhead): кто едет на восток, ждёт у навеса, где встают автобусы на восток. Без пар — те же станции,
   * в том же порядке и с тем же весом, что paxRoutes.
   */
  private paxDests(st: Station, routes?: Map<number, Line[]>): Map<number, { dest: number; at: Station; w: number; ride: number }> {
    const out = new Map<number, { dest: number; at: Station; w: number; ride: number }>();
    const mate = this.pairOf(st);
    const halves = mate ? [st, mate].sort((a, b) => a.id - b.id) : [st];
    const pos = (id: number) => this.stations.get(id)?.fp.center;
    for (const at of halves) {
      // routes — уже посчитанные paxRoutes(st): каждый кадр для каждой станции заново их не считаем.
      for (const [sid, lines] of at === st && routes ? routes : this.paxRoutes(at)) {
        const key = this.paxKey(sid);
        const was = out.get(key);
        // Выбирать есть из чего — только у пар: сколько ехать по линии от половины до половины.
        const ride = mate || key !== sid || this.pairOf(this.stations.get(sid)) ? Math.min(...lines.map((l) => rideAhead(l.stops, pos, at.id, sid))) : 0;
        if (!was) out.set(key, { dest: sid, at, w: this.paxWeight(sid), ride });
        else if (ride < was.ride - 0.5) Object.assign(was, { dest: sid, at, ride });
      }
    }
    return out;
  }

  /** До каких станций пассажиры ждут у этой (у половины пары — только те, кому отсюда ехать ближе, чем от второй). */
  paxWaitsFor(st: Station): Set<number> {
    const out = new Set<number>();
    for (const e of this.paxDests(st).values()) if (e.at === st) out.add(e.dest);
    return out;
  }

  /**
   * Какая доля пассажиров, что появляются на станции sid (у пары — на обеих половинах), сядет здесь на эту линию
   * (по весу направлений, как их выбирает updateStations); у линии без автобусов — сколько поехало бы, будь они.
   */
  private paxShare(line: Line, sid: number): number {
    const st = this.stations.get(sid);
    if (!st) return 0;
    const mate = this.pairOf(st);
    const dests = this.paxDests(st);
    const ours = new Set(line.stops.filter((o) => o !== sid && o !== mate?.id && this.stations.get(o)?.serves.pax).map((o) => this.paxKey(o)));
    let mine = 0;
    let all = 0;
    for (const k of ours) {
      const e = dests.get(k);
      const w = e?.w ?? this.paxWeight(k);
      all += w;
      // У пары — только те, кто ждёт на этой половине.
      if (!e || e.at.id === sid) mine += w;
    }
    let rest = 0;
    for (const [k, e] of dests) if (!ours.has(k)) rest += e.w;
    return mine ? mine / (all + rest) : 0;
  }

  private updateStations(dt: number): void {
    for (const st of this.stations.values()) {
      const routes = this.paxRoutes(st);
      const mate = this.pairOf(st);
      // Кому больше не на чем уехать (линию убрали или на ней теперь только грузовики) — расходятся; у пары — переходят
      // через улицу, если оттуда уехать можно.
      let mateRoutes: Map<number, Line[]> | undefined;
      for (const [sid, n] of st.passengers) {
        if (n > 0 && routes.has(sid)) continue;
        if (n > 0 && mate && (mateRoutes ??= this.paxRoutes(mate)).has(sid)) mate.passengers.set(sid, (mate.passengers.get(sid) ?? 0) + n);
        st.passengers.delete(sid);
      }
      if (mate) {
        // Пара: пассажиры появляются один раз на обе половины — у первой по номеру, уходят с каждой по своей очереди.
        if (st.id < mate.id && this.paxPop(st) > 0) this.paxArrive(st, [st, mate], dt, routes);
        this.paxWalkOff(st, routes, dt);
        continue;
      }
      if (st.catchPop <= 0) continue;
      if (!this.paxArrive(st, [st], dt, routes)) continue;
      this.paxWalkOff(st, routes, dt);
    }
  }

  /**
   * Новые пассажиры станции st (у пары — halves, обе половины): каждый — в своё направление по весу (paxDests) и
   * ждёт там, откуда поедет; очередь каждой половины — не больше её предела (stationCap). Ехать некуда — false.
   */
  private paxArrive(st: Station, halves: Station[], dt: number, routes: Map<number, Line[]>): boolean {
    const dests = this.paxDests(st, routes);
    if (!dests.size) return false;
    st.paxAcc += this.paxArrivals(st, dt);
    const waiting = new Map<number, number>();
    const cap = new Map<number, number>();
    for (const h of halves) {
      let w = 0;
      for (const c of h.passengers.values()) w += c;
      waiting.set(h.id, w);
      cap.set(h.id, this.stationCap(h, 'passengers'));
    }
    const room = (h: Station) => cap.get(h.id)! - waiting.get(h.id)!;
    const put = (h: Station, dest: number, k: number) => {
      h.passengers.set(dest, (h.passengers.get(dest) ?? 0) + k);
      waiting.set(h.id, waiting.get(h.id)! + k);
    };
    // Рабочие до станций у предприятий, которым их не хватает (enterprises.ts): сверх обычных пассажиров.
    for (const h of halves) {
      for (const [dock, n] of this.enterprises.spawnWorkers(h, dt)) {
        const e = dests.get(this.paxKey(dock));
        if (!e || e.dest !== dock) continue;
        const k = Math.min(n, room(e.at));
        if (k > 0) put(e.at, dock, k);
      }
    }
    while (st.paxAcc >= 1) {
      st.paxAcc -= 1;
      if (halves.every((h) => room(h) <= 0)) continue;
      let total = 0;
      for (const e of dests.values()) total += e.w;
      let r = this.rng.range(0, total);
      for (const e of dests.values()) {
        r -= e.w;
        if (r <= 0) {
          if (room(e.at) > 0) put(e.at, e.dest, 1);
          break;
        }
      }
    }
    return true;
  }

  /**
   * Очередь к линии на станции st: сколько ждёт её машин, сколько мест в приходящей машине (замер, а пока его нет —
   * вместимость; не меньше PAX_WAIT.minSeats от неё) и как часто они приходят. null — машин с пассажирами на линии нет.
   */
  paxQueue(line: Line, st: Station): { queue: number; seats: number; headway: number } | null {
    let n = 0;
    let capacity = 0;
    for (const id of line.vehicles) {
      const v = this.fleet.get(id);
      if (!v || MODELS[v.model].carries !== 'passengers') continue;
      n++;
      capacity += vehicleCapacity(v);
    }
    const index = line.stops.indexOf(st.id);
    if (!n || index < 0) return null;
    const cap = capacity / n;
    const seats = Math.max(cap * PAX_WAIT.minSeats, this.paxSeats.get(`${line.id}:${st.id}`) ?? cap);
    const headway = (this.lineLap(line) ?? MONTH_LENGTH) / n;
    return { queue: this.lineWaiting(line, index, 'passengers'), seats, headway };
  }

  /**
   * Длинная очередь — часть пассажиров уходит пешком или едет иначе (paxPatience.ts): каждый готов ждать тем
   * дольше, чем дальше ему ехать; ждать остаются, кого увезут машины, что придут за это время (и кто сядет в
   * ближайшую), остальные уходят из хвоста — по лучшей из линий, что туда идут. Ушедших считаем по направлениям
   * (Station.paxGone) и к линии (paxGoneSince — авто-парку: спрос, который линия не увезла).
   */
  private paxWalkOff(st: Station, routes: Map<number, Line[]>, dt: number): void {
    if (!st.passengers.size) return;
    const queues = new Map<Line, ReturnType<Game['paxQueue']>>();
    const queueOf = (line: Line) => {
      if (!queues.has(line)) queues.set(line, this.paxQueue(line, st));
      return queues.get(line)!;
    };
    for (const [dest, n] of st.passengers) {
      const to = this.stations.get(dest);
      const via = routes.get(dest);
      if (!to || !via || n < 1) continue;
      const patience = paxPatience(dist(st.fp.center, to.fp.center));
      let best: { line: Line; share: number } | null = null;
      for (const line of via) {
        const q = queueOf(line);
        // Линия без машин: пассажиры ждут первую, как раньше (их и так немного — stationCap).
        const share = q ? paxStayShare(paxTolerance(q.seats, q.headway, patience), q.queue) : 1;
        if (!best || share > best.share) best = { line, share };
      }
      const key = `${st.id}:${dest}`;
      if (!best || best.share >= 1) {
        this.paxLeaveAcc.delete(key);
        continue;
      }
      const acc = (this.paxLeaveAcc.get(key) ?? 0) + paxLeaving(n, best.share, dt);
      const k = Math.min(Math.floor(acc), Math.floor(n));
      this.paxLeaveAcc.set(key, acc - k);
      if (k <= 0) continue;
      st.passengers.set(dest, n - k);
      const gone = (st.paxGone ??= {});
      gone[dest] = (gone[dest] ?? 0) + k;
      const since = `${best.line.id}:${st.id}`;
      this.paxGoneSince.set(since, (this.paxGoneSince.get(since) ?? 0) + k);
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
      this.serviceTrips(town, dt);
    }
  }

  /** Выезды спецтранспорта города за dt — по seed партии (services.ts), общий генератор не трогают. */
  private serviceTrips(town: Town, dt: number): void {
    for (const n of serviceTick(town, dt)) {
      const call = this.serviceCars < SERVICE_TRAFFIC.maxCars ? serviceCall(this.seed, town, n) : null;
      if (call) this.spawnService(call.kind, call.siren, call.from.anchor, call.to.anchor, { from: call.from, to: call.to });
    }
  }

  /**
   * Спецмашина (скорая, полиция, пожарная) выезжает из узла from в узел to — как машина жителя, своим кузовом; siren —
   * с мигалкой; trip — из какого здания в какое (для карточки). Нет пути или места на выезде — null.
   */
  spawnService(kind: ServiceKind, siren: boolean, from: number, to: number, trip?: CarTrip): Vehicle | null {
    const route = this.roads.route(from, to);
    if (!route) return null;
    const sim = this.traffic.spawn({ ...SERVICES[kind].spec, siren, targetNode: to, route });
    if (!sim) return null;
    this.owners.set(sim.id, trip ? { type: 'service', kind, trip } : { type: 'service', kind });
    this.serviceCars++;
    return sim;
  }

  /** Машина в потоке — спецмашина города: какая (иначе undefined). */
  serviceOfSim(simId: number): ServiceKind | undefined {
    const owner = this.owners.get(simId);
    return owner?.type === 'service' ? owner.kind : undefined;
  }

  private spawnCitizenTrip(town: Town): void {
    const homes = town.buildings.filter((b) => b.kind === 'res');
    if (!homes.length) return;
    // Одно число общего генератора — дом с равным весом, как прежде (от него, как прежде, — цель и сколько ещё чисел
    // вытянуть: генератор тянет ровно те же числа, рост городов и мир по seed — те же), и дом поездки по весу числа
    // машин (CarHomes.pickHome).
    const u = this.rng.next();
    const first = homes[Math.floor(u * homes.length)];
    const origin = this.carHomes.pickHome(town, homes, u);
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
      route = this.roads.route(first.anchor, dest.anchor);
    }
    if (!route) {
      const jobs = town.buildings.filter((b) => b.kind === 'com');
      dest = this.rng.pick(jobs.length ? jobs : homes);
      if (dest.anchor === first.anchor) return;
      route = this.roads.route(first.anchor, dest.anchor);
    }
    if (!route || !dest) return;
    const color = this.rng.pick(CAR_COLORS);
    // Дальше — без общего генератора. Парк машин жителей (carHomes.ts) — по хешу: выезд машины дома со своего места
    // (гараж, площадка, двор, бокс) или возвращение на своё место машины, отстоявшей у чужой цели.
    if (origin !== first) {
      if (dest.anchor === origin.anchor) return;
      route = null;
    }
    const fleet = this.carHomes.trip(town, origin);
    // Стоянка магазина (shopParking.ts) — тоже по хешу: часть поездок к магазину кончается на его стоянке.
    const to = dest;
    const destTown = to.townId === town.id ? town : this.towns.find((t) => t.id === to.townId);
    const visit = destTown && fleet?.kind !== 'back' ? this.shops.visit(destTown, to) : null;
    if (fleet?.kind === 'out') {
      // Машиной в потоке (и в счёте citizenCars) станет, когда встанет на полосу (GarageHost.own); едет к магазину —
      // с полосы у места сразу к стоянке (поворотом направо или налево — что ближе, решится на полосе).
      // Иначе — место у цели (parkSearch.ts): полоса стоянки на её улице и соседних или площадка рядом, что ближе;
      // свободных нет — к ближнему из них искать (до трёх попыток, иначе домой). Мест нет вовсе — к узлу цели, как раньше.
      const park = visit ? null : this.parkSearch.plan(dest, this.roads.graph.outLinks.get(origin.anchor) ?? []);
      if (!visit) this.noteCurb(destTown, dest, park?.kind === 'curb' && !park.full);
      if (visit) {
        const then = (sim: Vehicle) => this.shops.start(sim, visit, this.carHomes.visit(fleet.car, fleet.town));
        this.carHomes.depart(fleet, dest, { target: visit.slot.link.toNode!, endLink: visit.slot.link.id, to: visit.planned, then });
      } else if (park) {
        const then = (sim: Vehicle) => this.parkSearch.start(sim, fleet, dest, park);
        if (park.kind === 'curb') this.carHomes.depart(fleet, dest, { target: park.link.toNode!, endLink: park.link.id, then });
        else if (park.kind === 'yard') this.carHomes.depart(fleet, dest, { target: park.slot.link.toNode!, endLink: park.slot.link.id, to: park.spot, then });
        else if (park.node !== undefined) this.carHomes.depart(fleet, dest, { target: park.node, then });
        else this.carHomes.depart(fleet, dest, { target: park.slot!.link.toNode!, endLink: park.slot!.link.id, to: park.spot, then });
      } else this.carHomes.depart(fleet, dest);
      return;
    }
    // К своему месту и к стоянке — с поворотом направо или налево через встречку, что ближе (Garages.wayHome); стоит
    // у цели на полосе стоянки — выезжает с места (CarHomes.leaveCurb).
    if (fleet?.kind === 'back') {
      const from = fleet.from ?? origin;
      if (fleet.curb && this.carHomes.leaveCurb(fleet)) return;
      if (fleet.lot && this.carHomes.leaveLot(fleet)) return;
      if (fleet.yard && this.carHomes.leaveYard(fleet)) return;
      const way = this.carHomes.homeWay(from.anchor, fleet.car);
      const sim = way && this.traffic.spawn({ ...CAR_SPEC, color: fleet.car.color, targetNode: way.toNode, route: way.route });
      if (sim) {
        // Куда — дом места (у бокса — гаражи): туда и ведёт линия маршрута.
        this.owners.set(sim.id, { type: 'citizen', trip: { from, to: fleet.car.place!.at } });
        this.carHomes.homeward(sim, fleet, way.slot);
        this.citizenCars++;
        return;
      }
    }
    route ??= this.roads.route(origin.anchor, dest.anchor);
    if (!route) return;
    if (visit) {
      const way = this.garages.wayHome(origin.anchor, visit.planned);
      const sim = way && this.traffic.spawn({ ...CAR_SPEC, color, targetNode: way.slot.link.toNode!, route: way.route });
      if (sim) {
        this.owners.set(sim.id, { type: 'citizen', trip: { from: origin, to } });
        visit.slot = way.slot;
        this.shops.start(sim, visit);
        this.citizenCars++;
        return;
      }
    }
    const sim = this.traffic.spawn({ ...CAR_SPEC, color, targetNode: dest.anchor, route });
    if (!sim) return;
    // Откуда и куда — уже выбранные дом и цель (без новых случайных чисел): для карточки машины.
    this.owners.set(sim.id, { type: 'citizen', trip: { from: origin, to: dest } });
    this.citizenCars++;
  }

  /** Что стоянкам магазинов (shopParking.ts) нужно от игры. */
  private shopHost(): ShopHost {
    const game = this;
    return {
      get seed() {
        return game.seed;
      },
      get time() {
        return game.time;
      },
      car: CAR_SPEC,
      colors: CAR_COLORS,
      canDrive: () => this.citizenCars < TOWN_TRAFFIC.maxCars,
      yardBusy: (b) => this.docks.yardBusy(b),
      backHome: (_town, car) => this.carHomes.backHome(car),
      // Машины на стоянках в начале партии — машины парка (новые партии с парковками): уедут на свои места.
      adopt: (town, b, spot, until, u) => (parkingOn(this.settings) ? this.carHomes.adopt(town, b, spot, until, u) : undefined),
      colorOf: (car) => this.carHomes.colorOf(car),
    };
  }

  /** Что парку машин жителей (carHomes.ts) нужно от игры. */
  private carHomesHost(): CarHomesHost {
    const game = this;
    return {
      get seed() {
        return game.seed;
      },
      get time() {
        return game.time;
      },
      get towns() {
        return game.towns;
      },
      car: CAR_SPEC,
      colors: CAR_COLORS,
    };
  }

  /** Что площадкам-стоянкам (lotParking.ts) нужно от игры. */
  private lotHost(): LotHost {
    const game = this;
    return {
      get time() {
        return game.time;
      },
      get towns() {
        return game.towns;
      },
      get traffic() {
        return game.traffic;
      },
      get graph() {
        return game.roads.graph;
      },
      car: CAR_SPEC,
      rev: () => this.lotRev,
      own: (sim, trip) => this.gHost.own(sim, trip),
      yardBusy: (b) => this.docks.yardBusy(b),
    };
  }

  /** Что поиску места у цели (parkSearch.ts) нужно от игры. */
  private searchHost() {
    const game = this;
    return {
      get time() {
        return game.time;
      },
      get graph() {
        return game.roads.graph;
      },
      get traffic() {
        return game.traffic;
      },
      townOf: (id: number) => this.towns.find((t) => t.id === id),
    };
  }

  /** Что полосам стоянки (curbParking.ts) нужно от игры: поток, сеть, кузов, учёт машин жителей, где мест нет. */
  private curbHost(): CurbHost {
    const game = this;
    return {
      get traffic() {
        return game.traffic;
      },
      get graph() {
        return game.roads.graph;
      },
      get net() {
        return game.roads.net;
      },
      car: CAR_SPEC,
      // Тот же учёт, что у гаражей (и замер «из ниоткуда», carFlow.ts, — по нему же).
      own: (sim, trip) => this.gHost.own(sim, trip),
      gone: (sim) => this.gHost.gone(sim),
      curbSkips: () => this.curbSkips(),
      lights: (id) => this.roads.net.nodes.get(id)?.control === 'lights',
    };
  }

  /** Где на полосах стоянки мест нет — по `${полотно}:${сторона}`; пересчёт — когда сменились дома или остановки. */
  private curbSkipCache: { sig: string; graph: object; skips: Map<string, [number, number][]> } | null = null;

  /**
   * Заезды во дворы, гаражи, на площадки и стоянки магазинов (ширина заезда и по CURB.drivePad с каждой стороны) и
   * остановки (±CURB.stopRoom от узла остановки, с обеих сторон улицы): там мест на полосе стоянки нет.
   */
  private curbSkips(): { sig: string; skips: Map<string, [number, number][]> } {
    const sig = `${this.towns.map((t) => t.buildings.length).join(',')}|${this.stations.size}|${this.lotRev}`;
    const graph = this.roads.graph;
    const hit = this.curbSkipCache;
    if (hit && hit.sig === sig && hit.graph === graph) return hit;
    const net = this.roads.net;
    const skips = new Map<string, [number, number][]>();
    const push = (key: string, a: number, b: number) => {
      const list = skips.get(key);
      if (list) list.push([a, b]);
      else skips.set(key, [[a, b]]);
    };
    // Только у полотен со стоянкой: прочие места не нужны.
    const parked = new Set([...net.corridors.values()].filter((c) => c.lanes.some((l) => l.park)).map((c) => c.id));
    const drive = (d: Driveway | null | undefined) => {
      const at = d && drivewayLink(net, d);
      if (!at || !parked.has(at.corridor)) return;
      const w = d.width / 2 + CURB.drivePad;
      push(`${at.corridor}:${at.side}`, at.s - w, at.s + w);
    };
    if (parked.size) {
      const L = CAR_SPEC.length;
      for (const town of this.towns) {
        for (const b of town.buildings) {
          const form = formOf(b);
          if (form === 'cottage' || form === 'dacha') drive(drivewayOf(b));
          const lot = b.kind !== 'landmark' ? yardLotOf(b) : null;
          if (lot) {
            const ys = yardSpots(b, lot, L);
            drive(ys.gate);
            for (const s of ys.spots) drive(s.drive);
          }
          if (b.kind === 'com') for (const s of this.shops.lotOf(b)?.spots ?? []) drive(s.d);
        }
        // Ворота площадок-стоянок (у большой — тупик-выезд: там перекрёсток, места у него и так нет).
        for (const lot of town.lots ?? []) if (!lot.removed && !lot.nodes?.length) for (const g of lot.gates) drive(lotGateDriveway(lot, g));
      }
      for (const st of this.stations.values()) {
        if (st.kind !== 'stop') continue;
        const n = net.nodes.get(st.nodeId);
        if (!n) continue;
        for (const id of n.corridors) {
          if (!parked.has(id)) continue;
          const c = net.corridor(id);
          const s = c.a === n.id ? 0 : c.length;
          for (const side of [1, -1]) push(`${id}:${side}`, s - CURB.stopRoom, s + CURB.stopRoom);
        }
      }
    }
    this.curbSkipCache = { sig, graph, skips };
    return this.curbSkipCache;
  }

  /** Границы мест на полосах стоянки в кадре (рисунок разметки, вблизи). */
  curbMarks(box: [number, number, number, number]): [Vec, Vec][] {
    return this.curb.marks(box);
  }

  /** Что гаражам частных домов (garages.ts) нужно от игры. */
  private garageHost(): GarageHost {
    const game = this;
    return {
      get seed() {
        return game.seed;
      },
      get traffic() {
        return game.traffic;
      },
      get graph() {
        return game.roads.graph;
      },
      get net() {
        return game.roads.net;
      },
      car: CAR_SPEC,
      colors: CAR_COLORS,
      own: (sim, trip) => {
        this.owners.set(sim.id, { type: 'citizen', trip });
        this.citizenCars++;
      },
      gone: (sim) => {
        this.owners.delete(sim.id);
        this.citizenCars--;
        this.carHomes.gone(sim.id);
      },
    };
  }

  /**
   * Машины у гаражей и площадок частных домов, во дворах и на стоянках магазинов в кадре: стоящие дома и на местах
   * (вблизи, parked — carHomes.ts, shopParking.ts) и на манёвре во дворе (garages.ts).
   */
  garageLooks(box: [number, number, number, number], parked: boolean): GarageLook[] {
    const out = this.garages.looks(this.towns, box, false);
    // Манёвры у бордюра на полосах стоянки (вне потока) — всегда, как манёвры во дворах.
    out.push(...this.curb.looks(box));
    if (parked) out.push(...this.carHomes.looks(box), ...this.shops.looks(this.towns, box, parked));
    return out;
  }

  /**
   * Слой «🅿️»: занятость мест — дворов, гаражных боксов и стоянок магазинов — по клеткам (parkingLayer.ts): сколько
   * мест и сколько занято.
   */
  parkingLayer(): ParkingCell[] {
    // Места полос стоянки — каждое своей точкой (занято: стоит гость или хозяин дома, к нему едут, на нём манёвр).
    const pts = [...this.carHomes.occupancy(), ...this.curb.occupancy(), ...this.lots.occupancy()];
    for (const town of this.towns) {
      for (const b of town.buildings) {
        const lot = b.kind === 'com' ? this.shops.lotOf(b) : null;
        if (!lot) continue;
        const used = lot.spots.filter((s, k) => this.garages.isBusy(s.key) || town.shopParked?.some((c) => c.b === b.id && c.k === k)).length;
        pts.push({ pos: b.fp.center, total: lot.spots.length, used });
      }
    }
    // Отказы за месяц (не нашли места у цели — домой) — красным; где кружат сейчас — штриховкой.
    const refused: Record<string, number> = {};
    for (const t of this.towns) for (const [k, n] of Object.entries(t.parkRefused ?? {})) refused[k] = (refused[k] ?? 0) + n;
    return parkingCells(pts, undefined, { refused, circling: this.parkSearch.circling().map((c) => c.dest) });
  }

  /** Откуда и куда едет машина жителя или спецмашина (здания и их города); не знаем (после загрузки, чужая) — null. */
  tripOf(simId: number): CarTrip | null {
    const o = this.owners.get(simId);
    return (o?.type === 'citizen' || o?.type === 'service') && o.trip ? o.trip : null;
  }

  /** Линия маршрута выбранной машины — пересчитывается, только когда она перешла на следующую связь (или сеть изменилась). */
  private aheadCache: { sim: number; route: number[]; index: number; graph: object; pts: Vec[] } | null = null;

  /**
   * Куда едет машина в потоке — для выбранной (не для всего потока): маршрут по полосам от неё до цели (точки), сколько
   * ещё метров и примерно секунд на скорости ×1 (по разрешённой скорости дорог, не быстрее самой машины) и где цель —
   * здание поездки (tripOf) или конец маршрута. Машины нет или маршрут кончился — null.
   */
  vehicleAhead(simId: number): { pts: Vec[]; left: number; eta: number; goal: Vec } | null {
    const v = this.traffic.vehicles.get(simId);
    if (!v) return null;
    // У места (гараж, площадка, стоянка магазина, garages.aheadOf): линия — до самого места, а не до конца полосы.
    const spot = this.garages.aheadOf(simId);
    const length = (pts: Vec[]) => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);
    if (spot?.only) {
      const pts = spot.tail!;
      const left = length(pts);
      const trip = this.tripOf(simId);
      return pts.length < 2 ? null : { pts, left, eta: left / 4, goal: trip ? trip.to.fp.center : pts[pts.length - 1] };
    }
    if (v.routeIndex >= v.route.length) return null;
    const g = this.roads.graph;
    let c = this.aheadCache;
    if (!c || c.sim !== simId || c.route !== v.route || c.index !== v.routeIndex || c.graph !== g) {
      c = { sim: simId, route: v.route, index: v.routeIndex, graph: g, pts: this.roads.routePolyline(v.route.slice(v.routeIndex)) };
      this.aheadCache = c;
    }
    if (c.pts.length < 2) return null;
    // Линия идёт от начала текущей связи — обрезаем её у машины: с ближайшей точки первой связи (выезжающая задним
    // ходом — от места, где она встанет на полосу).
    const first = g.links.get(v.route[v.routeIndex]);
    const reach = (first?.length ?? 0) + 30;
    const from = spot?.anchor ?? v.pos;
    let best = 0;
    let bestD = Infinity;
    let run = 0;
    for (let i = 0; i < c.pts.length && run <= reach; i++) {
      if (i) run += dist(c.pts[i - 1], c.pts[i]);
      const d = dist(c.pts[i], from);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    let pts = [...(spot?.head ?? [v.pos]), ...c.pts.slice(best + 1)];
    if (spot?.tail?.length) {
      // Едет к месту: по полосам — до точки поворота (ближайшей к ней на последней связи), дальше — поворот и заезд.
      const turn = spot.tail[0];
      const last = g.links.get(v.route[v.route.length - 1]);
      const back = (last?.length ?? 0) + 30;
      let cut = 1;
      let cutD = Infinity;
      for (let i = pts.length - 1, run = 0; i >= 1 && run <= back; i--) {
        run += dist(pts[i - 1], pts[i]);
        const d = dist(pts[i], turn);
        if (d < cutD) {
          cutD = d;
          cut = i;
        }
      }
      // Ближайшая точка ещё до поворота — она остаётся; машина уже у точки поворота — сразу поворот.
      if (cut < pts.length - 1 && dot(sub(turn, pts[cut]), sub(pts[cut + 1], pts[cut])) > 0) cut++;
      if (dist(pts[0], turn) <= cutD) cut = 1;
      pts = [...pts.slice(0, cut), ...spot.tail];
    }
    if (pts.length < 2) return null;
    const route = this.traffic.routeLeft(v);
    const left = spot ? length(pts) : route;
    // Время: остаток текущей связи и все следующие — каждая на своей скорости, не быстрее машины.
    const speed = (l: { speed: number } | undefined) => Math.max(1, Math.min(l?.speed ?? v.maxSpeed, v.maxSpeed));
    let rest = 0;
    let eta = 0;
    for (let i = v.routeIndex + 1; i < v.route.length; i++) {
      const l = g.links.get(v.route[i]);
      rest += l?.length ?? 0;
      eta += (l?.length ?? 0) / speed(l);
    }
    eta += Math.max(0, route - rest) / speed(first);
    // У места линия не та же, что маршрут по полосам, — время по ней же, в той же пропорции.
    if (spot && route > 1) eta *= left / route;
    const trip = this.tripOf(simId);
    return { pts, left, eta, goal: trip ? trip.to.fp.center : pts[pts.length - 1] };
  }

  // ---------- Месяц ----------

  /**
   * Стоимость всех дорог и путей — от неё считается ремонт. Города каждый месяц достраивают улицы, и сеть
   * дорог всякий раз новая — поэтому полотна считаются по одному: прежние (та же форма, класс, полосы, уровни
   * концов и рельеф) берутся готовыми. Цены целые — сумма та же, что и подряд.
   */
  roadValueTotal(): number {
    const version = (this.net.version * 100003 + this.roads.net.version) * 1009 + this.terrain.version;
    if (this.roadValue.version !== version) {
      const railVersion = this.net.version * 1009 + this.terrain.version;
      if (this.railValue.version !== railVersion) {
        let rails = 0;
        // Строящийся путь (ж/д проект) в ремонт не идёт — как и строящееся полотно: готов — у него снимется build.
        for (const s of this.net.segments.values()) if (!s.build) rails += this.builder.segmentCost(s);
        this.railValue = { version: railVersion, value: rails };
      }
      let total = this.railValue.value;
      const net = this.roads.net;
      const ground = this.ground();
      for (const c of net.corridors.values()) {
        // Строящееся ремонтировать не нужно: в ремонт — когда участок готов (у него снимется build).
        if (c.build) continue;
        const key = `${this.terrain.version}|${net.node(c.a).level}|${net.node(c.b).level}|${c.cls}|${JSON.stringify(c.curve)}|${JSON.stringify(c.lanes)}`;
        let hit = this.corridorValue.get(c.id);
        if (hit?.key !== key) {
          hit = { key, cost: corridorCost(net, c, (p, m) => this.isWater(p, m), ground) };
          this.corridorValue.set(c.id, hit);
        }
        total += hit.cost;
      }
      for (const id of this.corridorValue.keys()) if (!net.corridors.has(id)) this.corridorValue.delete(id);
      this.roadValue = { version, value: total };
    }
    return this.roadValue.value;
  }

  /**
   * Итоги месяца. Между yield — неделимые шаги: экономика и предприятия, рост каждого города, сборка графа
   * движения, переезд машин на него, остальное. В браузере шаги идут по кадрам (monthBudget), такты партии
   * в это время стоят — порядок и числа те же, что и целиком.
   */
  private *monthEnd(): Generator<void, void, void> {
    // Содержание транспорта и бригад, ремонт и проценты списывались весь месяц (accrueUpkeep, такт до конца месяца
    // начислен): здесь — только остаток, меньше доллара по статье. За полный месяц — та же сумма, что прежде одним
    // платежом.
    this.payUpkeep(true);

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
    this.industryRev++;
    // Ушедшие, не дождавшись автобуса (paxPatience.ts): итог месяца.
    for (const st of this.stations.values()) {
      if (st.paxGone) st.paxGoneLast = st.paxGone;
      else delete st.paxGoneLast;
      delete st.paxGone;
    }
    this.growIndustries();
    // Пустующие места в черте городов: город строит сам (enterprises.ts).
    this.enterprises.monthEnd();
    // Площадки-стоянки: счёт месяца — в прошлый, отказы клеток — заново.
    this.closeLots();
    yield;
    // Улицы городов: граф движения по каждой новой улице и переезд на него машин — не сразу внутри стройки,
    // а отдельными шагами после города (roads.quiet, roads.step): те же графы в том же порядке, но по кадрам.
    // Подряд, в одном кадре, несколько улиц подвешивали смену месяца на сотни миллисекунд.
    for (const town of this.towns) {
      this.roads.quiet(() => {
        this.growTown(town);
        // Полосы стоянки там, где у целей не хватало мест (новые партии).
        this.curbGrow(town);
        // Площадки у рынка, ратуши и станций без мест рядом (новые партии; без сноса).
        this.townLots(town);
      });
      yield;
      while (this.roads.step()) yield;
    }
    // Город мог слить или убрать узел у ворот базы.
    this.healBaseGates();
    // Город вырос: переходы «сами» — по новым домам, пешеходов — по новым жителям.
    if (this.syncCrosswalks(true)) this.roads.changed();
    this.crosswalks.refreshPeople();
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
    // На грани банкротства (по счёту и темпу содержания) — напоминание каждый месяц.
    this.warnBrink(true);
    yield;
    // Сценарий — после экономики месяца: снабжение городов и рост предприятий уже подсчитаны.
    this.scenario?.monthEnd();
    // Задания без сроков — в песочнице и после конца сценария (в идущем сценарии молчат).
    this.ideas.monthEnd();
    this.journalMonth();
    this.timelapse.capture(this);
  }

  /**
   * Итоги месяца в журнал: деньги и статьи, линии, предприятия, у которых что-то происходит (уровень, выпуск,
   * сырьё на складе, груз на станциях), города и прогресс заданий сценария.
   */
  private journalMonth(): void {
    const last = this.history[this.history.length - 1];
    const stations = [...this.stations.values()];
    const waiting = (ind: Industry) =>
      stations.filter((st) => st.industryIds.includes(ind.id)).reduce((s, st) => s + (st.cargo[ind.info.produces] ?? 0), 0);
    const stock = (ind: Industry) => Object.values(ind.stock).reduce<number>((s, x) => s + (x ?? 0), 0);
    const inds = this.industries
      .map((i) => [i.id, i.level ?? 1, i.producedLast, Math.floor(stock(i)), Math.floor(waiting(i)), i.streak ?? 0])
      .filter(([, level, made, st, wait]) => level !== 1 || made > 0 || st > 0 || wait > 0);
    const sc = this.scenario;
    this.journal.add('month', {
      date: last?.label,
      money: Math.round(this.money),
      loan: this.loan,
      income: last?.income,
      expenses: last?.expenses,
      ledger: last?.ledger,
      lines: [...this.lines.values()].map((l) => [l.id, l.revenueLast, l.costLast, l.carriedLast, l.loadLast ?? null, l.vehicles.length]),
      inds,
      towns: this.towns.map((t) => [t.id, t.population, this.townSatisfaction(t), t.lastSupplied]),
      obj: sc?.running ? sc.current.map((o) => [o.id, o.progress, o.target, sc.monthsLeft(o)]) : undefined,
      rep: sc?.state.reputation,
      fx: sc?.state.effects.map((e) => `${e.kind}:${e.target}×${e.factor}`),
    });
  }

  /**
   * Предприятие растёт, если его продукцию исправно вывозят (на станциях она не копится),
   * и сокращается, если долго нет маршрута через его станции. Так большим линиям и поездам есть что возить.
   */
  private growIndustries(): void {
    const E = ECONOMY;
    for (const ind of this.industries) {
      if (!isActive(ind)) continue;
      const level = ind.level ?? 1;
      const c = ind.info.produces;
      const stations = [...this.stations.values()].filter((st) => st.serves.cargo && st.industryIds.includes(ind.id) && this.routed(st));
      // Больше половины месяца копилось у самого предела станции — транспорт не успевает, расти незачем.
      // Старые сохранения без счётчика — по тому, что на станции сейчас.
      const piled =
        ind.piledMonth !== undefined
          ? ind.piledMonth > MONTH_LENGTH * 0.5
          : stations.some((st) => (st.cargo[c] ?? 0) >= this.stationCap(st, 'freight') * 0.9 || this.stationFull(st));
      ind.piledMonth = 0;
      const good = stations.length > 0 && ind.producedLast > 0 && !piled;
      let streak = ind.streak ?? 0;
      if (good) streak = Math.max(1, streak + 1);
      else if (!stations.length) streak = Math.min(-1, streak - 1);
      else streak = 0;
      // Сам — до предела пристроек (ANNEX.base без них); дальше расти некуда — нужна пристройка (annexReady).
      const cap = growthCap(ind);
      if (streak >= E.growthMonths && level < cap) {
        ind.level = Math.min(cap, level + E.growthStep);
        streak = 0;
        if (Math.floor(ind.level) > Math.floor(level))
          this.notify(`${ind.name}: производство выросло до ×${ind.level}`, '#2e9d57', {
            kind: 'industry',
            refs: [{ type: 'industry', id: ind.id }],
            recipe: industryRecipe(ind.info, ind.name),
          });
      } else if (streak <= -E.declineMonths && level > 1) {
        ind.level = Math.max(1, level - E.growthStep);
        streak = 0;
      }
      ind.streak = streak;
    }
    this.industryRev++;
  }

  /** Сколько предприятие производит (или может переработать) в месяц сейчас. */
  industryRate(ind: Industry): number {
    if (!isActive(ind)) return 0;
    return Math.round((ind.info.accepts.length ? ECONOMY.processRate : ind.info.rate) * (ind.level ?? 1) * this.mods.industry(ind.id) * this.enterprises.rateFactor(ind));
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
    const need = lastTownNeed(town);
    const missing = town.demands.filter((c) => (town.lastSupplied[c] ?? 0) < need).map((c) => CARGO[c].name.toLowerCase());
    if (!missing.length) out.push({ mood: 'good', text: 'В магазинах всего хватает — город растёт' });
    else if (missing.length < town.demands.length) out.push({ mood: 'ok', text: `Не хватает: ${missing.join(', ')}` });
    else out.push({ mood: 'bad', text: `Пустые полки: нужны ${missing.join(', ')}` });
    // Предприятия рядом (режим «Строит игрок»): дым от вредных и работа на заводах.
    if (this.enterprises.on) {
      const e = this.enterprises.townInfo(town);
      const worst = e.harm[0];
      if (worst) out.push({ mood: e.harmTotal >= 0.3 ? 'bad' : 'ok', text: `Дым от «${worst.ind.info.name}» — город растёт медленнее (−${Math.round(Math.min(1, e.harmTotal) * 100)}%)` });
      if (e.pool > 0 && e.employed / e.pool >= 0.5) out.push({ mood: 'good', text: 'Есть работа на заводах рядом — город растёт быстрее' });
      else if (e.pool > 0 && e.employed > 0) out.push({ mood: 'ok', text: 'Работы рядом немного: заводу у города нашлись бы рабочие' });
    }
    return out;
  }

  /**
   * Доля закрытых потребностей города за прошлый месяц (0…1) — по норме того месяца (растёт с населением). С
   * получателями (retail) — по доле привезённого: норму закрывают все магазины вместе, и линия к половине из них
   * даёт половину прибавки к росту, а не ничего (docs/RETAIL.md, этап 4).
   */
  townSatisfaction(town: Town, month: 'last' | 'current' = 'last'): number {
    const src = month === 'last' ? town.lastSupplied : town.supplied;
    const need = monthTownNeed(town, month);
    if (!town.demands.length) return 0;
    if (this.retail) return town.demands.reduce((s, c) => s + Math.min(1, (src[c] ?? 0) / Math.max(1, need)), 0) / town.demands.length;
    const ok = town.demands.filter((c) => (src[c] ?? 0) >= need).length;
    return ok / town.demands.length;
  }

  /**
   * Закрывает месяц снабжения города: привезённое уходит в «прошлый месяц» и в историю по месяцам (для диаграммы
   * в карточке города), а новый месяц начинается с излишков — привезённого сверх нормы, не больше нормы
   * (world/townSupply.ts): месяц — минута, и рейс не обязательно успевает в каждый. Норма — по населению (townNeed).
   */
  private closeTownMonth(town: Town): void {
    const need = townNeed(town.population);
    const { got, carry } = closeSupply(town.demands, town.supplied, need);
    const month: TownSupplyMonth = { label: this.dateLabel, got, need };
    if (town.carried && Object.keys(town.carried).length) month.carried = town.carried;
    town.supplyHistory = [...(town.supplyHistory ?? []), month].slice(-TOWN_HISTORY);
    town.lastSupplied = { ...town.supplied };
    town.supplied = { ...carry };
    if (Object.keys(carry).length) town.carried = carry;
    else delete town.carried;
    closeTownPax(town);
  }

  /** Улицы, застроенные до отказа: id полотна → месяц, когда это выяснилось. Через 24 мин (два года) проверяем снова. */
  private readonly fullStreets = new Map<number, number>();

  /**
   * Город растёт от центра к краю: сначала застраивает свободные места у улиц поближе к центру,
   * а когда их нет — прокладывает короткую улицу у края плотной застройки. Дальше предела роста не строит.
   */
  private growTown(town: Town): void {
    this.closeTownMonth(town);
    const satisfaction = this.townSatisfaction(town);
    // Рост за месяц — по его длине (MONTH_SCALE): за секунду город растёт так же, как при коротком месяце.
    // Предприятия рядом: вредные тормозят рост, рабочие места — прибавляют (enterprises.ts; «Готовые» — ×1).
    town.growthAcc += town.population * (0.003 + 0.025 * satisfaction) * MONTH_SCALE * this.mods.growth(town.id) * this.enterprises.growth(town);
    // Рост к снабжённым магазинам (docs/RETAIL.md): улицы у получателя с грузом на складе — раньше в очереди, у пустого
    // RETAIL.dryMonths месяцев — дома не прибавляются (только когда город уже снабжают: иначе он не рос бы совсем).
    const { pulls, blocks } = this.retailGrowth(town);
    const blocked = blocks.length ? (p: Vec) => blocks.some((q) => dist(p, q) < RETAIL.block) : undefined;
    const growCtx = (): WorldContext => ({ ...this.worldContext(), blocked });
    const ctx = growCtx();
    const reach = this.townReach(town);
    const hadIds = new Set(town.buildings.map((b) => b.id));
    // Город растёт вдоль любых своих улиц, включая построенные игроком, — ближние к центру раньше.
    // Кроме магистралей, съездов и дорог развязок — к ним город не пристраивается.
    const pulled = (s: Corridor) => pulls.some((p) => dist(p, s.lut.closest(p).point) <= RETAIL.pull);
    const streets = this.roads.net
      .corridorsNear(town.center, reach)
      .filter((s) => this.streetLike(s) && !this.streetFull(s.id))
      .map((s) => ({ s, hit: s.lut.closest(town.center) }))
      .filter(({ hit }) => hit.d <= reach && this.ownedBy(town, hit.point))
      .map(({ s, hit }) => ({ s, d: hit.d + this.rng.range(0, TOWN_GROWTH.jitter) - (pulls.length && pulled(s) ? RETAIL.pullBonus : 0) }))
      .sort((a, b) => a.d - b.d);
    // Новые дома расселяются сразу, а рост расходуется по жильцам (GROW.perPerson за жителя или рабочее место):
    // частный дом на 4 жителя дешевле панельного на сотню — село растёт в домах так же быстро по доле, как город.
    recountPopulation(town);
    const before = town.population;
    const tier = townTier(town);
    const spend = (added: number) => {
      if (!added) return;
      const was = town.population;
      zoneTown(town);
      recountPopulation(town);
      town.growthAcc -= Math.max(added * GROW.min, (town.population - was) * GROW.perPerson);
    };
    const limit = () => Math.min(3, Math.max(1, Math.floor(town.growthAcc / GROW.unit)));
    let tries = 0;
    for (const { s } of streets) {
      if (town.growthAcc < GROW.min || tries++ >= 12 * MONTH_SCALE) break;
      const added = fillStreet(ctx, town, s, 1, limit(), reach);
      if (added) spend(added);
      else this.fullStreets.set(s.id, this.month);
    }
    // Мест вдоль улиц не хватает — город сам прокладывает новую улицу и застраивает её (если игрок не запретил);
    // не больше одной улицы на каждые прежние 40 секунд: за месяц — MONTH_SCALE (дробное — по очереди, 1 и 2 при 1.5).
    // Накопилось на десяток домов (частный сектор берёт много места на жителя) — улиц вдвое больше.
    const base = Math.floor((this.month + 1) * MONTH_SCALE) - Math.floor(this.month * MONTH_SCALE);
    const newStreets = town.growthAcc >= 10 * GROW.unit ? 2 * base : base;
    for (let k = 0; k < newStreets && town.growthAcc >= 2 * GROW.unit && town.autoStreets !== false; k++) {
      const seg = this.growStreet(town, reach);
      if (!seg) break;
      // Сеть после стройки — новая: дома ставим уже по ней.
      spend(fillStreet(growCtx(), town, seg, 0.8, Math.max(1, Math.floor(town.growthAcc / GROW.unit)), reach));
      town.growthAcc = Math.max(0, town.growthAcc);
    }
    recountPopulation(town);
    measureTown(town);
    // Село доросло до города, город — до большого: новые парки и скверы — на том пустом, что осталось.
    if (townTier(town) !== tier) placeParks(town, parkSite(this.worldContext()));
    // АЗС и оптовая база — из новых деловых домов (партии с получателями); получатели — по новому населению (больше
    // жителей — больше магазинов, их доли нормы меньше).
    if (this.retail) this.zoneRetailTown(town, new Set(town.buildings.filter((b) => b.kind === 'com' && !hadIds.has(b.id)).map((b) => b.id)));
    this.refreshReceivers(town);
    this.townRev++;
    if (town.population > before && satisfaction >= 1)
      this.notify(`${town.name} растёт: ${town.population} жителей`, undefined, { kind: 'town', refs: [{ type: 'town', id: town.id }] });
  }

  /**
   * Рост к снабжённым магазинам (партии с получателями; в конце месяца, перед ростом): пустые месяц подряд — в счёт
   * (world/retail.markDry); pulls — здания получателей с грузом на складе (улицы у них — раньше), blocks — пустых
   * RETAIL.dryMonths месяцев (дома рядом не прибавляются), но только если город уже снабжают (хоть один получатель
   * принимал груз): неснабжённый город растёт, как прежде.
   */
  private retailGrowth(town: Town): { pulls: Vec[]; blocks: Vec[] } {
    if (!this.retail || !town.receivers?.length) return { pulls: [], blocks: [] };
    markDry(town, this.time);
    const byId = new Map(town.buildings.map((b) => [b.id, b]));
    const pulls: Vec[] = [];
    const blocks: Vec[] = [];
    const fed = town.receivers.some((r) => r.fed);
    for (const r of town.receivers) {
      const b = byId.get(r.b);
      if (!b) continue;
      const rc = roofCenter(b);
      const p = lotFrame(b)(rc.x, rc.y);
      if (receiverStocked(town, r, this.time)) pulls.push(p);
      else if (fed && receiverDry(r)) blocks.push(p);
    }
    return { pulls, blocks };
  }

  private streetFull(id: number): boolean {
    const at = this.fullStreets.get(id);
    if (at === undefined) return false;
    if (this.month - at < 12 * TERM_SCALE) return true;
    this.fullStreets.delete(id);
    return false;
  }

  /**
   * Город, чьи улицы здесь (world/streetBans.ts): точка ближе к его центру, чем к другим, и не дальше, чем он может
   * дорасти улицами (townReach — не дальше края застройки и edgeMax; с запасом — город растёт). null — точка вне
   * городов. Без townReach: подпись сноса спрашивает каждый кадр, а он сортирует все дома.
   */
  private streetTownAt(p: Vec): Town | null {
    for (const t of this.towns) {
      if (dist(p, t.center) <= Math.max(t.radius + TOWN_GROWTH.edgeMax, t.extent ?? t.radius) + 150 && this.ownedBy(t, p)) return t;
    }
    return null;
  }

  /**
   * Снос полотна id запретит городу улицу на этом месте: на земле, не кольцо и не строящийся проект, в городе
   * (подсказка 🏘✕ при сносе — controller.ts).
   */
  streetBanAt(id: number): boolean {
    const net = this.roads.net;
    const c = net.corridors.get(id);
    if (!c || c.build || c.ring || net.node(c.a).level !== 0 || net.node(c.b).level !== 0) return false;
    return !!this.streetTownAt(c.lut.pointAt(c.length / 2));
  }

  /** Точка под дорогой: ближе STREET_BAN.near к оси какого-нибудь полотна. */
  private underRoad(p: Vec): boolean {
    return this.roads.net.corridorsNear(p, STREET_BAN.near + 30).some((c) => c.lut.closest(p).d < STREET_BAN.near);
  }

  /**
   * После действия игрока: городские улицы, которых больше нет (сравнение с сетью before до действия), — в запреты
   * городов. Куски, оставшиеся под дорогами (слияние полотен, сдвиг, смена полос), — не снос.
   */
  private banStreets(before: LaneNet): void {
    const net = this.roads.net;
    for (const c of before.corridors.values()) {
      const now = net.corridors.get(c.id);
      if (now && now.curve.p0.x === c.curve.p0.x && now.curve.p0.y === c.curve.p0.y && now.curve.p3.x === c.curve.p3.x && now.curve.p3.y === c.curve.p3.y) continue;
      if (c.build || c.ring || before.node(c.a).level !== 0 || before.node(c.b).level !== 0) continue;
      for (const run of uncoveredRuns(c, (p) => this.underRoad(p))) {
        const town = this.streetTownAt(run[Math.floor(run.length / 2)]);
        if (!town) continue;
        town.streetBans = [...(town.streetBans ?? []), run].slice(-STREET_BAN.max);
      }
    }
  }

  /** Запреты, на месте которых теперь дорога (её проложил игрок), сняты. */
  private liftStreetBans(): void {
    for (const t of this.towns) {
      if (!t.streetBans?.length) continue;
      const keep = t.streetBans.filter((ban) => !banCovered(ban, (p) => this.underRoad(p)));
      if (keep.length === t.streetBans.length) continue;
      if (keep.length) t.streetBans = keep;
      else delete t.streetBans;
    }
  }

  /** Новая улица города идёт вдоль улицы, снесённой игроком: так город не строит. */
  private streetBanned(c: Corridor): boolean {
    return this.towns.some((t) => t.streetBans?.some((ban) => alongBan(c, ban)));
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

  /**
   * Машина парка поехала к цели dest в городе town (не на стоянку магазина): ok — нашлось свободное место на полосе
   * стоянки рядом. По улице у цели — сколько просили и скольким не хватило (Town.curbAsk; рост — curbGrow).
   */
  private noteCurb(town: Town | undefined, dest: TownBuilding, ok: boolean): void {
    if (!town || !parkingOn(this.settings)) return;
    const c = this.roads.net.corridorNear(dest.fp.center, 80);
    if (!c) return;
    const ask = (town.curbAsk ??= {});
    const was = ask[c.id] ?? [0, 0];
    ask[c.id] = [was[0] + 1, was[1] + (ok ? 0 : 1)];
  }

  /**
   * Рост полос стоянки (новые партии, WorldSettings.parking; только при «Город строит улицы сам»): раз в месяц — одна
   * полоса на улице города, где за месяц не хватило мест больше CURB_GROW.short просивших (не меньше CURB_GROW.ask), со
   * стороны деловых домов (нет их — справа, потом слева). Только без сноса: участки домов могут ужаться. Счёт — заново.
   */
  private curbGrow(town: Town): void {
    const ask = town.curbAsk;
    delete town.curbAsk;
    if (!ask || !parkingOn(this.settings) || town.autoStreets === false) return;
    const net = this.roads.net;
    const list = Object.entries(ask)
      .map(([id, [n, miss]]) => ({ c: net.corridors.get(Number(id)), n, miss }))
      .filter((x): x is { c: Corridor; n: number; miss: number } => !!x.c && x.n >= CURB_GROW.ask && x.miss / x.n > CURB_GROW.short)
      .sort((x, y) => y.miss - x.miss || x.c.id - y.c.id);
    for (const { c } of list) {
      if (!this.streetLike(c) || !this.ownedBy(town, c.lut.pointAt(c.length / 2))) continue;
      const front = frontage(town, c);
      const com = (side: 1 | -1) => front.get(side)!.filter((b) => b.kind === 'com').length;
      const sides: (1 | -1)[] = com(1) >= com(-1) ? [1, -1] : [-1, 1];
      for (const side of sides) {
        const lanes = withCurb(net, c, side);
        if (!lanes) continue;
        const id = c.id;
        const plan = this.roadBuilder.plan((n) => n.setLanes(n.corridor(id), lanes), { free: true, shove: true });
        if (!plan.ok || plan.demolish.length || !plan.net) continue;
        this.roadBuilder.apply(plan);
        this.applyCurbSqueeze(plan.changed);
        return;
      }
    }
  }

  /** Сколько домов города стоит ближе r к точке. */
  private housesNear(town: Town, p: Vec, r: number): number {
    return this.index.near(p, r).filter((s) => s.type === 'building' && s.townId === town.id && dist(s.fp.center, p) < r).length;
  }

  /** Городская улица: на земле, не кольцо и не часть магистрали или развязки. */
  private streetLike(c: Corridor): boolean {
    const net = this.roads.net;
    // Строящаяся дорога (проект) — ещё не улица: город от неё не продолжает и дома вдоль неё не ставит.
    // Просёлок в поле — тоже: город не тянется вдоль него отростком. Грунтовка внутри города (оба конца — в круге
    // плотной застройки, как проложил бы игрок между кварталами) — улица, её застраивают.
    if (isDirt(c.cls) && !this.dirtInTown(c)) return false;
    return !c.build && !c.ring && net.node(c.a).level === 0 && net.node(c.b).level === 0 && !nearHighway(net, c, this.drivewayIds());
  }

  /** Грунтовка внутри города: оба её конца — в круге плотной застройки одного города. */
  private dirtInTown(c: Corridor): boolean {
    const a = this.roads.net.node(c.a).pos;
    const b = this.roads.net.node(c.b).pos;
    return this.towns.some((t) => dist(a, t.center) <= t.radius && dist(b, t.center) <= t.radius);
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
    const stationNodes = new Set([...this.stations.values()].filter((st) => st.kind !== 'dock').map((st) => st.nodeId));
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
        // Через парк и сквер город улицу не ведёт (townParks.ts).
        if (this.index.at(p, half) || nearPark(this.towns, p, half)) return false;
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
        if (this.index.at(p, half) || nearPark(this.towns, p, half)) return null;
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
      if (end && (end.kind === 'free' || stop < G.minStreet)) return null;
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
        if (m.id <= n.id || d < G.minStreet || d > step * 1.6 || m.corridors[0] === n.corridors[0] || !fits(m.pos)) continue;
        const chord = scale(sub(m.pos, n.pos), 1 / d);
        if (dot(out, scale(net.ends(m)[0].away, -1)) < 0.5 || Math.abs(dot(chord, out)) > 0.5) continue;
        if (clear(n.pos, chord, 12, d - 12, 25, d - 25, new Set([...n.corridors, ...m.corridors]))) push(start, { kind: 'node', node: m.id, pos: m.pos }, true);
      }
      // Продолжение — только у тупика, вдоль которого уже стоят дома: без «отростков» в чистом поле.
      if (this.housesNear(town, n.pos, G.builtUpRadius) < G.builtUp) continue;
      const a = angleOf(out) + rng.range(-bend, bend);
      push(start, cast(n.pos, { x: Math.cos(a), y: Math.sin(a) }, rng.range(0.7, 1) * step, skip), false);
    }
    // Переулки поперёк улиц — в просветах между домами.
    const streets = net.corridorsNear(center, reach).filter((s) => this.streetLike(s) && s.length > G.corner * 2.5 && s.lut.closest(center).d <= reach);
    for (let k = 0; k < 24 && streets.length; k++) {
      const s = rng.pick(streets);
      const side = rng.chance(0.5) ? 1 : -1;
      const span = s.length - 2 * G.corner;
      const off = rng.range(0, span);
      for (let i = 0; i < span; i += 8) {
        const at = G.corner + ((off + i) % span);
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
      // Вдоль улицы, снесённой игроком, город не строит (world/streetBans.ts).
      if (added.some((x) => this.streetBanned(x))) continue;
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
   * На один путь — только платформа на главном пути и здание рядом, без съездов. platform — длина платформ, м.
   * terminal — конечная: горловина со стрелками с одной стороны, с другой пути кончаются упорами; ставится
   * в конец пути (у тупика) или в чистое поле.
   */
  private railStationPlan(p: Vec, snapRadius: number, angle: number, tracks: number, platform: number, terminal = false): StationPlan {
    const R = RAIL_STATION;
    const fail = (reason: string, fp: Footprint | null = null, cost = railStationFee(tracks, platform)): StationPlan => ({
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
    const half = platform / 2 + switchLen;
    const margin = MIN_SEGMENT_LEN + 20;
    // Путь, на который ставим станцию: существующий или новый прямой участок в чистом поле.
    let seg: { id: number; lut: CurveLUT; length: number };
    let sc: number;
    let main: RoadRequest | undefined;
    let mainCost = 0;
    // Конечная: в какую сторону вдоль пути (по росту длины или против) упоры.
    let toward: 1 | -1 = 1;
    // Что мешает главному пути в чистом поле — скажем после того, как посчитаем силуэт станции (он красным).
    let mainProblem: string | undefined;
    if (hit && terminal) {
      // Конечная — у тупика: платформы доходят до самого конца пути, там упоры.
      seg = hit.seg;
      const dead = (id: number) => this.net.node(id).segments.length === 1 && this.net.node(id).buildingId === null;
      // Тупик — тот, к которому курсор ближе, и не дальше самой станции: иначе она «уехала» бы в конец длинного пути.
      const away = (end: 1 | -1) => (end > 0 ? seg.length - hit.s : hit.s);
      const deadEnds = ([-1, 1] as const)
        .filter((end) => dead(end > 0 ? hit.seg.b : hit.seg.a) && away(end) <= platform + switchLen + 60)
        .sort((x, y) => away(x) - away(y));
      if (!deadEnds.length) return fail('Конечная — у тупика пути или в чистом поле');
      toward = deadEnds[0];
      if (seg.length < platform + switchLen + margin) return fail('Нужен длинный прямой участок пути у тупика');
      sc = toward > 0 ? seg.length - platform / 2 : platform / 2;
    } else if (hit) {
      seg = hit.seg;
      if (seg.length < 2 * (half + margin)) return fail('Нужен длинный прямой участок пути');
      sc = Math.max(half + margin, Math.min(seg.length - half - margin, hit.s));
    } else {
      const dir = { x: Math.cos(angle), y: Math.sin(angle) };
      // Конечная в чистом поле: платформы — у курсора, подход с горловиной — сзади (против направления).
      const back = terminal ? platform / 2 + switchLen + margin : half + margin;
      const ahead = terminal ? platform / 2 : half + margin;
      const a = sub(p, scale(dir, back));
      const b = add(p, scale(dir, ahead));
      // Главный путь вокзала в чистом поле — часть станции: готов сразу и «Со строительством» (instant).
      main = { start: { kind: 'free', pos: a, level: 0 }, end: { kind: 'free', pos: b, level: 0 }, spec: RAIL_SPEC, mode: 'straight', instant: true };
      const mp = this.builder.plan(main);
      if (!mp.ok) mainProblem = mp.reason ?? 'Нельзя построить путь';
      else if (mp.crossings.length || mp.demolish.length) mainProblem = 'Мешает дорога или здание';
      mainCost = mp.cost;
      const lut = new CurveLUT(straightCubic(a, b));
      seg = { id: -1, lut, length: lut.length };
      sc = back;
    }
    const t = seg.lut.tangentAt(sc);
    const center = seg.lut.pointAt(sc);
    // Конечная: горловина, начало платформы и упор — вдоль пути к упорам (u).
    const toBuffers = scale(t, toward);
    const ends = terminal ? { throat: sc - toward * (platform / 2 + switchLen), start: sc - (toward * platform) / 2, buffer: sc + (toward * platform) / 2 } : null;
    const cuts: [number, number, number, number] = [sc - half, sc - platform / 2, sc + platform / 2, sc + half];
    const checks = ends ? [ends.throat, ends.start, ends.buffer] : cuts;
    const curved = checks.some((s) => dot(seg.lut.tangentAt(s), t) < Math.cos(0.06));
    // Дополнительные пути и здание — со стороны курсора (в чистом поле — слева от направления, R поворачивает).
    const n = hit && cross(t, sub(p, center)) < 0 ? { x: t.y, y: -t.x } : { x: -t.y, y: t.x };
    const h = switchLen * 0.4;
    const extra: ([Cubic, Cubic] | [Cubic, Cubic, Cubic])[] = [];
    if (ends) {
      // Тупики: съезд от стрелки горловины, платформа до упора.
      const j0 = seg.lut.pointAt(ends.throat);
      for (let k = 1; k < tracks; k++) {
        const a = add(seg.lut.pointAt(ends.start), scale(n, R.spacing * k));
        const b = add(seg.lut.pointAt(ends.buffer), scale(n, R.spacing * k));
        extra.push([{ p0: j0, p1: add(j0, scale(toBuffers, h)), p2: sub(a, scale(toBuffers, h)), p3: a }, straightCubic(a, b)]);
      }
    } else {
      const j0 = seg.lut.pointAt(cuts[0]);
      const j1 = seg.lut.pointAt(cuts[3]);
      for (let k = 1; k < tracks; k++) {
        const a = add(seg.lut.pointAt(cuts[1]), scale(n, R.spacing * k));
        const b = add(seg.lut.pointAt(cuts[2]), scale(n, R.spacing * k));
        extra.push([
          { p0: j0, p1: add(j0, scale(t, h)), p2: sub(a, scale(t, h)), p3: a },
          straightCubic(a, b),
          { p0: b, p1: add(b, scale(t, h)), p2: sub(j1, scale(t, h)), p3: j1 },
        ]);
      }
    }
    // Проходная: здание сбоку, вдоль путей. Конечная: в торце — за упорами, поперёк всех путей с платформами
    // (от главного до боковой платформы у крайнего), между упорами и зданием — перрон к платформам.
    const across = { lo: -(RAIL_HALF + 4), hi: R.spacing * (tracks - 1) + RAIL_HALF + 8 };
    const headW = Math.max(36, across.hi - across.lo);
    const fp: Footprint = ends
      ? {
          center: add(
            add(seg.lut.pointAt(ends.buffer), scale(toBuffers, R.concourse + R.size.h / 2)),
            scale(n, (across.lo + across.hi) / 2),
          ),
          w: headW,
          h: R.size.h,
          angle: angleOf(n),
        }
      : {
          center: add(center, scale(n, R.spacing * (tracks - 1) + RAIL_HALF + 4 + R.size.h / 2)),
          // У короткой платформы и здание короче — не длиннее её самой.
          w: Math.min(R.size.w, Math.max(36, platform - 10)),
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
    const cost = Math.round(length * specCost(RAIL_SPEC)) + railStationFee(tracks, platform) + mainCost;
    // Нельзя — силуэт (здание, пути с платформами и главный путь) всё равно показываем, красным.
    const rail: RailStationGeom = ends
      ? { segId: seg.id, terminal: { throat: seg.lut.pointAt(ends.throat), start: seg.lut.pointAt(ends.start), buffer: seg.lut.pointAt(ends.buffer) }, tracks: extra, main }
      : { segId: seg.id, cuts, tracks: extra, main };
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

  /**
   * angle — поворот ж/д станции в чистом поле, tracks — сколько у неё путей с платформами (1–4),
   * platform — их длина, м (50–400), terminal — конечная (тупиковая) вместо проходной. road — как ставить
   * автостанцию или автовокзал: длина выезда или вдоль дороги с карманом.
   */
  stationPlan(
    p: Vec,
    snapRadius: number,
    kind: StationKind = 'road',
    angle = 0,
    tracks = 2,
    platform: number = RAIL_STATION.platform,
    terminal = false,
    road: RoadStationOptions = {},
  ): StationPlan {
    if (kind === 'rail') return this.railStationPlan(p, snapRadius, angle, clampRailTracks(tracks), clampRailLength(platform), terminal);
    if (kind === 'stop') return this.stopPlan(p, snapRadius);
    if (road.curb) return this.curbStationPlan(p, snapRadius, road.curbBays ?? STATION.curb.bays);
    if (road.side) return this.sideStationPlan(p, snapRadius);
    const len = clampDriveway(road.driveway ?? STATION.driveway);
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
      if (this.stationJoinable(end)) return this.junctionStationPlan(end, p, len);
      const fp = this.drivewayFootprint(hit.seg.lut.pointAt(hit.s), normalTowards(hit.seg, hit.s, p), halfAtS(hit.seg, hit.s), len);
      return fail('Слишком близко к перекрёстку', fp);
    }
    // Рядом с дорогой магнит небольшой (иначе в городе всё липло бы к перекрёсткам), в стороне от дорог — побольше.
    const magnet = hit ? Math.max(30, Math.min(50, snapRadius * 2)) : 80;
    const junction = this.roads.net
      .nodesNear(p, magnet)
      .filter((n) => this.stationJoinable(n))
      .sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0];
    if (junction) return this.junctionStationPlan(junction, p, len);
    if (!hit) {
      // Рядом только магистраль: вдоль быстрых дорог станций нет — силуэт всё равно у неё, с понятной причиной.
      const fast = this.roadNear(p, Math.max(40, snapRadius), (c) => isTrunk(c.cls));
      if (fast) {
        const fp = this.drivewayFootprint(fast.seg.lut.pointAt(fast.s), normalTowards(fast.seg, fast.s, p), halfAtS(fast.seg, fast.s), len);
        return fail('К магистрали станцию не пристроить', fp);
      }
      return fail('Поставьте рядом с дорогой', this.looseFootprint(p, STATION.size));
    }
    const seg = hit.seg;
    const from: Anchor = { kind: 'corridor', corridor: seg.id, s: hit.s, pos: seg.lut.pointAt(hit.s) };
    return this.drivewayStationPlan(from, normalTowards(seg, hit.s, p), halfAtS(seg, hit.s), len);
  }

  /**
   * Улица, которой принадлежит полотно c, между перекрёстками: c и соседние полотна за стыками посреди улицы (не
   * перекрёсток и не тупик), если улица за стыком продолжается почти прямо, того же класса и с теми же полосами.
   * u — путь вдоль c по a→b (у c.a — 0, кускам до него — меньше нуля); улица — от from до to. at(u) — точка на ней,
   * касательная по направлению c и края полотна (как edgesAt, справа от этого направления — плюс). clear — сколько
   * отступить от узла у from и у to, чтобы примкнуть к улице новой дорогой.
   */
  private streetLine(c: Corridor): {
    from: number;
    to: number;
    clear: [number, number];
    /** От узла на конце улицы до стоп-линии перекрёстка там (у тупика — 0), у from и у to. */
    stop: [number, number];
    /** Узлы на концах улицы: у from и у to. */
    ends: [number, number];
    /** Полотна улицы по порядку: где начинается (u0), длина и идёт ли по направлению c (fwd). */
    pieces: { id: number; u0: number; length: number; fwd: boolean }[];
    at(u: number): { pos: Vec; t: Vec; edges: [number, number] | null };
  } {
    const net = this.roads.net;
    const sig = (x: Corridor, fwd: boolean) =>
      x.lanes
        .map((l) => (fwd ? l.flow : -l.flow))
        .sort()
        .join(',');
    const own = sig(c, true);
    // Касательная полотна x по направлению улицы на его конце (end: 0 — где улица в него входит, 1 — выходит).
    const tan = (x: Corridor, fwd: boolean, end: 0 | 1) => {
      const t = x.lut.tangentAt(fwd === (end === 1) ? x.length : 0);
      return fwd ? t : scale(t, -1);
    };
    const pieces: { c: Corridor; u0: number; fwd: boolean }[] = [{ c, u0: 0, fwd: true }];
    const seen = new Set([c.id]);
    const next = (cur: Corridor, curFwd: boolean, nodeId: number, ahead: boolean): { c: Corridor; fwd: boolean } | null => {
      const nd = net.node(nodeId);
      if (nd.kind !== 'seam' || nd.corridors.length !== 2 || nd.level !== 0) return null;
      const id = nd.corridors.find((x) => x !== cur.id);
      if (id === undefined || seen.has(id)) return null;
      const x = net.corridor(id);
      if (x.a === x.b || x.cls !== c.cls || x.ring) return null;
      // Вперёд: x начинается в этом узле, если идёт по улице (a — здесь). Назад: x кончается здесь.
      const fwd = ahead ? x.a === nodeId : x.b === nodeId;
      if (sig(x, fwd) !== own) return null;
      const far = net.node(fwd === ahead ? x.b : x.a);
      if (far.level !== 0) return null;
      const bend = ahead ? dot(tan(cur, curFwd, 1), tan(x, fwd, 0)) : dot(tan(cur, curFwd, 0), tan(x, fwd, 1));
      if (bend < Math.cos((10 * Math.PI) / 180)) return null;
      seen.add(id);
      return { c: x, fwd };
    };
    let to = c.length;
    let tail = { piece: pieces[0], node: c.b };
    while (to < 3000) {
      const x = next(tail.piece.c, tail.piece.fwd, tail.node, true);
      if (!x) break;
      const piece = { ...x, u0: to };
      pieces.push(piece);
      to += x.c.length;
      tail = { piece, node: x.fwd ? x.c.b : x.c.a };
    }
    let from = 0;
    let head = { piece: pieces[0], node: c.a };
    while (from > -3000) {
      const x = next(head.piece.c, head.piece.fwd, head.node, false);
      if (!x) break;
      from -= x.c.length;
      const piece = { ...x, u0: from };
      pieces.unshift(piece);
      head = { piece, node: x.fwd ? x.c.a : x.c.b };
    }
    // Отступ от узла на конце улицы: не меньше MIN_SEGMENT_LEN, а от поперечной дороги — чтобы кромка примыкающей
    // к улице новой дороги (до полуширины улицы) не заходила на её кромку (как «Слишком близко к другой дороге» у
    // строителя дорог): их полуширины, под острым углом — длиннее. Дорога, которая продолжает улицу за узлом (почти
    // по прямой), не в счёт.
    const clear = (end: { piece: { c: Corridor; fwd: boolean }; node: number }, ahead: boolean): number => {
      const inward = scale(tan(end.piece.c, end.piece.fwd, ahead ? 1 : 0), ahead ? -1 : 1);
      let m = MIN_SEGMENT_LEN;
      for (const id of net.node(end.node).corridors) {
        if (id === end.piece.c.id) continue;
        const o = net.corridor(id);
        const out = o.a === end.node ? o.lut.tangentAt(0) : scale(o.lut.tangentAt(o.length), -1);
        const cos = dot(out, inward);
        if (cos < -Math.cos(Math.PI / 6)) continue;
        const sin = Math.max(0.5, Math.sqrt(Math.max(0, 1 - cos * cos)));
        m = Math.max(m, (LANE_W + ROAD_MARGIN + halfAtS(o, o.a === end.node ? 0 : o.length) - 1) / sin + 0.5);
      }
      return m;
    };
    const at = (u: number) => {
      const q = Math.min(Math.max(u, from), to);
      const piece = pieces.find((x) => q <= x.u0 + x.c.length) ?? pieces[pieces.length - 1];
      const L = piece.c.length;
      const s = Math.min(Math.max(piece.fwd ? q - piece.u0 : L - (q - piece.u0), 0), L);
      const t = piece.c.lut.tangentAt(s);
      const e = edgesAt(piece.c, s);
      return {
        pos: piece.c.lut.pointAt(s),
        t: piece.fwd ? t : scale(t, -1),
        edges: e && (piece.fwd ? e : ([-e[1], -e[0]] as [number, number])),
      };
    };
    // Стоп-линия у перекрёстка на конце улицы (nodeCuts): от узла до неё; у тупика и прочих узлов — 0.
    const stop = (end: { piece: { c: Corridor }; node: number }): number => {
      const nd = net.node(end.node);
      if (nd.kind !== 'junction') return 0;
      const ends = net.ends(nd);
      const i = ends.findIndex((e) => e.corridor.id === end.piece.c.id && e.node.id === nd.id);
      return i >= 0 ? (nodeCuts(net, nd, ends)[i] ?? 0) : 0;
    };
    return {
      from,
      to,
      clear: [clear(head, false), clear(tail, true)],
      stop: [stop(head), stop(tail)],
      ends: [head.node, tail.node],
      pieces: pieces.map((x) => ({ id: x.c.id, u0: x.u0, length: x.c.length, fwd: x.fwd })),
      at,
    };
  }

  /**
   * Автостанция или автовокзал вдоль дороги: площадка боком к улице со стороны курсора, между ними — дублёр:
   * односторонняя дорога в одну полосу по ходу движения этого края улицы — съезд с улицы, вдоль площадки и обратный
   * въезд на улицу (между улицей и дублёром — островок). Узел станции — стык на дублёре напротив её середины:
   * машины съезжают на дублёр, встают на посты прямо с него и возвращаются на улицу дальше по ходу.
   * Не у перекрёстка и не у конца улицы, не рядом с другой станцией или остановкой.
   */
  private sideStationPlan(p: Vec, snapRadius: number): StationPlan {
    const fail = (reason: string, fp: Footprint | null = null): StationPlan => ({ ok: false, reason, cost: COST.station, fp, side: true });
    const hit = this.streetNear(p, Math.max(40, snapRadius));
    if (!hit) return fail('Поставьте вдоль улицы', this.looseFootprint(p, STATION.size));
    const c = hit.seg;
    const W = STATION.size.w;
    // Вдоль площадки — run с каждой стороны от узла, съезд и въезд — ещё по div; от перекрёстков и концов улицы — с
    // отступом (streetLine.clear: не меньше MIN_SEGMENT_LEN, у проспекта — больше). Стыки посреди улицы (продолжение
    // той же улицы) не мешают — карман ложится и на соседнее полотно. Хватает длины — площадка сама сдвигается вдоль
    // улицы от перекрёстка, чтобы съезд и въезд уместились.
    const run = W / 2 + STATION.pocketRun;
    const div = STATION.pocketDiverge;
    const line = this.streetLine(c);
    const lo = line.from + run + div + line.clear[0];
    const hi = line.to - run - div - line.clear[1];
    const need = 2 * (run + div) + line.clear[0] + line.clear[1];
    const have = line.to - line.from;
    const fits = hi >= lo;
    const u = fits ? Math.min(Math.max(hit.s, lo), hi) : hit.s;
    // Сторона улицы — со стороны курсора: 1 — справа от a→b полотна c. Дублёр едет туда же, куда полосы у этого края
    // (правостороннее движение).
    const right = dot(normalTowards(c, hit.s, p), rightNormal(c.lut.tangentAt(hit.s))) > 0 ? 1 : -1;
    const along = right;
    const here = line.at(u);
    const t = here.t;
    const point = here.pos;
    const n = scale(rightNormal(t), right);
    const dir = scale(t, along);
    const edges = here.edges ?? [-LANE_W, LANE_W];
    const edge = (right > 0 ? edges[1] : -edges[0]) + ROAD_MARGIN;
    const laneHalf = LANE_W / 2 + ROAD_MARGIN;
    // Ось дублёра — за островком; площадка — сразу за его кромкой.
    const d = edge + STATION.pocketIsland + laneHalf;
    const N = add(point, scale(n, d));
    const fp: Footprint = {
      center: add(point, scale(n, d + laneHalf + STATION.pocketGap + STATION.size.h / 2)),
      w: W,
      h: STATION.size.h,
      angle: Math.atan2(t.y, t.x),
    };
    // У края в другую сторону полос нет (односторонняя улица) — дублёр вливался бы навстречу.
    if (!c.lanes.some((l) => l.flow === along)) return fail('Улица здесь — в другую сторону', fp);
    if (!fits) return fail(`Мало места вдоль улицы: нужно ${Math.ceil(need)} м между перекрёстками, здесь ${Math.floor(have)} м`, fp);
    for (const st of this.stations.values()) {
      if (st.id === this.movingStation || st.kind === 'rail' || st.kind === 'dock') continue;
      if (dist(st.fp.center, fp.center) < W + STOP.gap) return fail(st.kind === 'stop' ? 'Рядом уже есть остановка' : 'Рядом уже есть станция', fp);
    }
    if (!this.inBounds(fp.center, 30)) return fail('За краем карты', fp);
    if (this.isWater(fp.center, footprintRadius(fp))) return fail('Мешает вода', fp);
    const under = this.structuresUnder(fp, 2);
    if (under.blocker) return fail(under.blocker, fp);
    const road = this.roadUnder(fp, 2);
    if (road) return fail(road, fp);
    const P0 = line.at(u - along * (run + div)).pos;
    const P1 = line.at(u + along * (run + div)).pos;
    // Съезд и въезд отходят от улицы под углом (~30°) и выходят на дублёр уже вдоль неё — плавно, без излома.
    const k = div * 0.5;
    const tilt = 0.58;
    const opts = { cls: 'street' as const, lanes: oneWay(1) };
    const plan = this.roadBuilder.plan((nn) => {
      // Съезд — от полотна под P0 (у стыка — от самого стыка: из него выйдет перекрёсток).
      const from = anchorAt(nn, P0, 3);
      if (from.kind === 'free') return false;
      const off: Cubic = { p0: from.pos, p1: add(add(from.pos, scale(dir, k)), scale(n, k * tilt)), p2: sub(N, scale(dir, run + k)), p3: N };
      buildRoad(nn, from, { kind: 'free', pos: N }, { ...opts, curve: off });
      const node = nn.nodesNear(N, 1)[0];
      const back = anchorAt(nn, P1, 3);
      if (!node || back.kind === 'free') return false;
      const on: Cubic = { p0: N, p1: add(N, scale(dir, run + k)), p2: add(sub(back.pos, scale(dir, k)), scale(n, k * tilt)), p3: back.pos };
      buildRoad(nn, { kind: 'node', node: node.id, pos: N }, back, { ...opts, curve: on });
    });
    const cost = plan.cost + COST.station + this.demolishTotal(under.houses);
    const done = { cost, fp, driveway: plan, nodePos: N, demolish: under.houses, side: true };
    if (!plan.ok) return { ...done, ok: false, reason: plan.reason ?? 'Нельзя поставить' };
    if (cost > this.budget) return { ...done, ok: false, reason: 'Не хватает денег' };
    return { ...done, ok: true };
  }

  /**
   * Автовокзал у края улицы (Station.curb, числа — STATION.curb): перрон с навесом вплотную к бордюру со стороны
   * курсора, автобусы встают у него прямо на улице, друг за другом носом по ходу движения этого края. Хватает улицы
   * между стоп-линиями перекрёстков — вдоль мест кармашек (полоса у края с отгонами, curbLayout), нет — места в крайней
   * полосе, как у остановки. Узел станции — стык на улице у заднего края мест: сюда маршрут ведёт автобус, отсюда он
   * проезжает к своему месту (curbDwell). Стыки посреди улицы не мешают — кармашек ложится на соседние полотна; курсор
   * у перекрёстка сдвигает площадку вдоль улицы. Не на односторонней улице против движения и не рядом с другой
   * станцией или остановкой.
   */
  private curbStationPlan(p: Vec, snapRadius: number, bays: number): StationPlan {
    const C = STATION.curb;
    const k = clampCurbBays(bays);
    const cost0 = COST.station + Math.max(0, k - STATION.bays) * STATION.bayCost;
    const size = { w: k * C.berth + 2 * C.end, h: C.depth };
    const fail = (reason: string, fp: Footprint | null = null, curb?: StationPlan['curb']): StationPlan => ({ ok: false, reason, cost: cost0, fp, ...(curb ? { curb } : {}) });
    const hit = this.streetNear(p, Math.max(40, snapRadius));
    if (!hit) return fail('Поставьте у края улицы', this.looseFootprint(p, size));
    const c = hit.seg;
    const net = this.roads.net;
    const line = this.streetLine(c);
    const T = taperLen(c.cls);
    // Отступ от конца улицы: у перекрёстка — до его стоп-линии, у тупика и прочих узлов — MIN_SEGMENT_LEN.
    const end = (i: 0 | 1) => (net.node(line.ends[i]).kind === 'junction' ? line.stop[i] : MIN_SEGMENT_LEN);
    const room = line.to - line.from - end(0) - end(1);
    const have = line.to - line.from;
    const withPocket = curbLayout(k, T, true);
    const plain = curbLayout(k, T, false);
    const pocket = 2 * withPocket.half <= room;
    const lay = pocket ? withPocket : plain;
    const curb = { bays: k, pocket, need: Math.ceil(2 * withPocket.half + end(0) + end(1)), have: Math.floor(have) };
    // Сторона улицы — со стороны курсора: 1 — справа от a→b полотна c; места — по ходу полос у этого края.
    const right = dot(normalTowards(c, hit.s, p), rightNormal(c.lut.tangentAt(hit.s))) > 0 ? 1 : -1;
    const along = right;
    // Середина мест (u вдоль улицы) — у курсора, но не ближе half к концам улицы.
    const lo = line.from + end(0) + lay.half;
    const hi = line.to - end(1) - lay.half;
    const fits = hi >= lo;
    // Кармашек — на стольких-то полотнах улицы; стык между ними не должен попасть на отгон (там полоса сужается), а
    // узел станции — вплотную к стыку: сдвигаем середину мест на ближайшее место, где так.
    const seams = line.pieces.slice(1).map((x) => x.u0);
    // Узел — у заднего края мест; с кармашком — в начале его полной ширины (стык не режет отгон), задний автобус
    // встаёт и за узлом, на половине отгона.
    const back = pocket ? lay.zone / 2 - 1 : lay.stand / 2;
    const usable = (m: number): boolean => {
      const uN = m - along * back;
      if (seams.some((b) => Math.abs(b - uN) < 3)) return false;
      if (!pocket) return true;
      const a = m - lay.half;
      const b = m + lay.half;
      return !seams.some((x) => (x > a - 1 && x < a + T + 1) || (x > b - T - 1 && x < b + 1));
    };
    let u = fits ? Math.min(Math.max(hit.s, lo), hi) : hit.s;
    if (fits && !usable(u)) {
      const alt = [...Array(40).keys()].flatMap((i) => [u + (i + 1), u - (i + 1)]).find((m) => m >= lo && m <= hi && usable(m));
      if (alt !== undefined) u = alt;
    }
    const here = line.at(u);
    const t = here.t;
    const n = scale(rightNormal(t), right);
    const edges = here.edges ?? [-LANE_W, LANE_W];
    const edge = (right > 0 ? edges[1] : -edges[0]) + ROAD_MARGIN;
    const fp: Footprint = {
      center: add(here.pos, scale(n, edge + (pocket ? LANE_W : 0) + C.depth / 2)),
      w: lay.stand + 2 * C.end,
      h: C.depth,
      angle: Math.atan2(t.y, t.x),
    };
    if (!c.lanes.some((l) => l.flow === along)) return fail('Улица здесь — в другую сторону', fp, curb);
    if (!fits) return fail(`Мало места вдоль улицы: нужно ${Math.ceil(2 * plain.half + end(0) + end(1))} м между перекрёстками, здесь ${Math.floor(have)} м`, fp, curb);
    if (!usable(u)) return fail('Мешает стык улицы — сдвиньте вдоль неё', fp, curb);
    for (const st of this.stations.values()) {
      if (st.id === this.movingStation || st.kind === 'rail' || st.kind === 'dock') continue;
      if (dist(st.fp.center, fp.center) < (fp.w + st.fp.w) / 2 + STOP.gap) return fail(st.kind === 'stop' ? 'Рядом уже есть остановка' : 'Рядом уже есть станция', fp, curb);
    }
    if (!this.inBounds(fp.center, 30)) return fail('За краем карты', fp, curb);
    if (this.isWater(fp.center, footprintRadius(fp))) return fail('Мешает вода', fp, curb);
    const under = this.structuresUnder(fp, 1);
    if (under.blocker) return fail(under.blocker, fp, curb);
    // Площадка вплотную к бордюру своей улицы: её кромку у улицы не проверяем.
    const road = this.roadUnder({ ...fp, center: add(fp.center, scale(n, 0.75)), h: fp.h - 1.5 }, 0.5);
    if (road) return fail(road, fp, curb);
    const uN = u - along * back;
    const atNode = line.at(uN);
    const nodePos = atNode.pos;
    const plan = this.roadBuilder.plan((nn) => {
      if (pocket) {
        // Полоса кармашка — у внешней кромки этого края на каждом полотне под ним: полная ширина — между отгонами.
        const zone = [u - lay.half + T, u + lay.half - T];
        for (const pc of line.pieces) {
          const p0 = pc.u0;
          const p1 = pc.u0 + pc.length;
          if (p1 <= u - lay.half + 0.5 || p0 >= u + lay.half - 0.5) continue;
          const x = nn.corridor(pc.id);
          const sideC = pc.fwd ? right : -right;
          const flow = (pc.fwd ? along : -along) as 1 | -1;
          const edge = x.lanes.reduce((m, l) => (l.offset * sideC > m.offset * sideC ? l : m));
          // Вплотную снаружи крайней полосы (полоса стоянки уже полосы движения).
          const outer = besideOffset(edge, sideC, LANE_W) - sideC * LANE_W;
          const local = (q: number) => (pc.fwd ? q - p0 : pc.length - (q - p0));
          const a = local(Math.max(zone[0], p0));
          const b = local(Math.min(zone[1], p1));
          let from = Math.min(a, b);
          let to = Math.max(a, b);
          // Полоса продолжается за стыком — до него без отгона.
          const atStart = zone[0] <= p0 + 0.01;
          const atEnd = zone[1] >= p1 - 0.01;
          if (pc.fwd ? atStart : atEnd) from = 0;
          if (pc.fwd ? atEnd : atStart) to = Infinity;
          nn.setLanes(x, [...x.lanes, { offset: outer + sideC * LANE_W, flow, from, to }]);
        }
      }
      // Узел станции — стык у заднего края мест.
      const pc = line.pieces.find((x) => uN >= x.u0 && uN <= x.u0 + x.length);
      if (!pc) return false;
      const s = pc.fwd ? uN - pc.u0 : pc.length - (uN - pc.u0);
      const { node } = splitCorridor(nn, nn.corridor(pc.id), s, 'seam');
      // К автовокзалу автобусы подъезжают только по своей половине улицы — к перрону.
      node.arrive = dot(node.dir, atNode.t) * along > 0 ? 1 : -1;
    });
    const cost = plan.cost + cost0 + this.demolishTotal(under.houses.filter((id) => !plan.demolish.includes(id)));
    const done = { cost, fp, driveway: plan, nodePos, demolish: under.houses.filter((id) => !plan.demolish.includes(id)), curb };
    if (!plan.ok) return { ...done, ok: false, reason: plan.reason ?? 'Нельзя поставить' };
    if (cost > this.budget) return { ...done, ok: false, reason: 'Не хватает денег' };
    return { ...done, ok: true };
  }

  /**
   * Автобусная остановка: навес у края улицы со стороны курсора, улица в этом месте режется стыком —
   * это узел остановки: автобусы встают у неё прямо в полосе. Не у перекрёстка и не рядом с другой остановкой —
   * кроме остановки напротив (stopMate): с ней новая встаёт парой (Station.pair), узлом не ближе STOP.pair.shift.
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
    const side = normalTowards(c, hit.s, p);
    const mate = this.stopMate(c, hit.s, side);
    // Напротив остановки узел ближе shift не встанет (кусок улицы между стыками — не короче 10 м): сдвигаем в сторону
    // курсора от её узла (d — от курсора до него вдоль c).
    const shift = STOP.pair.shift;
    const s = !mate || Math.abs(mate.d) >= shift ? hit.s : mate.d >= 0 ? hit.s + mate.d - shift : hit.s + mate.d + shift;
    const t = c.lut.tangentAt(Math.min(Math.max(s, 0), c.length));
    const point = c.lut.pointAt(Math.min(Math.max(s, 0), c.length));
    const fp: Footprint = {
      center: add(point, scale(side, halfAtS(c, Math.min(Math.max(s, 0), c.length)) + 2 + STOP.size.h / 2)),
      w: STOP.size.w,
      h: STOP.size.h,
      angle: Math.atan2(t.y, t.x),
    };
    if ((s < STOP.corner && near('a')) || (c.length - s < STOP.corner && near('b'))) return fail('Слишком близко к перекрёстку', fp);
    if (s < 10 || c.length - s < 10) return fail('Слишком близко к узлу', fp);
    // Пара — на улице в обе стороны: у каждой половины свои автобусы, в одну сторону вторая половина пустовала бы.
    if (mate && !(c.lanes.some((l) => l.flow === 1) && c.lanes.some((l) => l.flow === -1))) return fail('Улица в одну сторону — пары не будет', fp);
    // Другие остановки и станции рядом на этой же улице (переносимая и та, к которой встаём парой, — не в счёт).
    for (const st of this.stations.values()) {
      if (st.id === this.movingStation || st.id === mate?.st.id || st.kind === 'dock') continue;
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
    return { ok: true, cost, fp, driveway: plan, nodePos: point, demolish: under.houses, ...(mate ? { pair: mate.st.id } : {}) };
  }

  /**
   * Остановка напротив точки s улицы c (side — сторона, где встанет новая): на этой же улице (через стыки), узлом не
   * дальше STOP.pair.reach вдоль оси, навесом на другой стороне и ещё без пары (переносимая не в счёт, её собственная
   * пара — можно: она снова встанет парой к ней). d — от s до её узла вдоль c (к концу b — плюс). Нет — null.
   */
  private stopMate(c: Corridor, s: number, side: Vec): { st: Station; d: number } | null {
    const net = this.roads.net;
    const byNode = new Map<number, Station>();
    for (const st of this.stations.values()) if (st.kind === 'stop' && st.id !== this.movingStation) byNode.set(st.nodeId, st);
    let best: { st: Station; d: number } | null = null;
    for (const dir of [1, -1] as const) {
      let node = dir > 0 ? c.b : c.a;
      let d = dir > 0 ? c.length - s : s;
      let from = c.id;
      while (d <= STOP.pair.reach) {
        const st = byNode.get(node);
        if (st) {
          const at = net.node(node).pos;
          const free = st.pair === undefined || st.pair === this.movingStation || !this.pairOf(st);
          if (free && dot(sub(st.fp.center, at), side) < 0 && (!best || d < Math.abs(best.d))) best = { st, d: d * dir };
          break;
        }
        const n = net.nodes.get(node);
        const next = n && n.kind === 'seam' && n.corridors.length === 2 ? net.corridors.get(n.corridors[0] === from ? n.corridors[1] : n.corridors[0]) : undefined;
        if (!next) break;
        d += next.length;
        from = next.id;
        node = next.a === node ? next.b : next.a;
      }
    }
    return best;
  }

  /**
   * Предпросмотр пары: остановка по плану встанет парой к той, что напротив, — навесы обеих (сначала новая) и куда у
   * каждой поедут автобусы; name — общее название. Не пара — null.
   */
  pairPreview(plan: StationPlan): { name: string; halves: { fp: Footprint; dir: Vec }[] } | null {
    const mate = plan.pair !== undefined ? this.stations.get(plan.pair) : undefined;
    const node = mate && this.roads.net.nodes.get(mate.nodeId);
    if (!plan.ok || !plan.fp || !plan.nodePos || !mate || !node) return null;
    return {
      name: mate.name,
      halves: [
        { fp: plan.fp, dir: curbHeading(plan.fp.center, plan.nodePos) },
        { fp: mate.fp, dir: curbHeading(mate.fp.center, node.pos) },
      ],
    };
  }

  /** Вторая половина пары остановок (Station.pair); нет пары (или вторая уже не считает её своей) — undefined. */
  pairOf(st: Station | undefined): Station | undefined {
    if (st?.pair === undefined) return undefined;
    const mate = this.stations.get(st.pair);
    return mate?.pair === st.id ? mate : undefined;
  }

  /** Жители у остановки — у пары на обе половины (каждый дом — у ближней, без двойного счёта; computeCatchment). */
  paxPop(st: Station): number {
    return st.catchPop + (this.pairOf(st)?.catchPop ?? 0);
  }

  /** Куда едут автобусы, что встают у половины пары: навес справа по ходу (как LaneNode.arrive). Не пара — null. */
  stopHeading(st: Station): Vec | null {
    const node = this.pairOf(st) && this.roads.net.nodes.get(st.nodeId);
    return node ? curbHeading(st.fp.center, node.pos) : null;
  }

  /**
   * Узел остановки — цель только с её стороны (правостороннее движение: навес справа по ходу), on = false — с любой.
   */
  private setStopSide(st: Station, on: boolean): void {
    const node = this.roads.net.nodes.get(st.nodeId);
    if (!node) return;
    if (!on) {
      delete node.arrive;
      return;
    }
    node.arrive = dot(sub(st.fp.center, node.pos), rightNormal(node.dir)) > 0 ? 1 : -1;
  }

  /**
   * Две остановки напротив — пара: у каждой узел только для своей стороны, жители делятся по ближней половине,
   * маршруты через них встают у той половины, к которой подъезжают по своей полосе (pairRoute), машины в пути
   * пересчитывают дорогу к ней.
   */
  private pairStops(a: Station, b: Station): void {
    a.pair = b.id;
    b.pair = a.id;
    this.stationRev++;
    this.setStopSide(a, true);
    this.setStopSide(b, true);
    this.computeCatchment(a);
    this.computeCatchment(b);
    this.legCache.clear();
    for (const line of this.lines.values()) if (line.stops.includes(a.id) || line.stops.includes(b.id)) this.remapLine(line, this.pairRoute(line.stops));
    this.rerouteTo([a, b]);
    this.journal.add('pair', { a: a.id, b: b.id, name: a.name });
  }

  /**
   * Пара распалась (половину снесли или увезли дальше STOP.pair.reach): у обеих узел снова с любой стороны, жители —
   * каждой свои. Возвращает вторую половину.
   */
  private unpairStop(st: Station): Station | undefined {
    const mate = this.pairOf(st);
    delete st.pair;
    this.stationRev++;
    if (!mate) return undefined;
    delete mate.pair;
    this.setStopSide(st, false);
    this.setStopSide(mate, false);
    this.computeCatchment(st);
    this.computeCatchment(mate);
    this.legCache.clear();
    this.rerouteTo([st, mate]);
    this.journal.add('pair-', { a: st.id, b: mate.id });
    return mate;
  }

  /** Машины, что едут к этим остановкам, заново ищут к ним дорогу: к узлу — уже с нужной стороны (или с любой). */
  private rerouteTo(sts: Station[]): void {
    const nodes = new Set(sts.map((s) => s.nodeId));
    for (const v of this.fleet.values()) {
      const sim = this.fleetSim(v);
      if (sim && v.state === 'driving' && !v.boarding && nodes.has(sim.targetNode)) this.traffic.redirect(sim, sim.targetNode);
    }
  }

  /**
   * Пары остановок в маршруте stops: пара — одна точка, автобус встаёт у той половины, к которой подъезжает от
   * предыдущей остановки по своей полосе, без разворота (до неё короче). Пара дважды подряд (конечная: приехал и
   * уехал обратно) — обе половины по очереди: сначала та, к которой подъехал, потом напротив. Длина — та же.
   */
  pairRoute(stops: readonly number[]): number[] {
    const out = [...stops];
    const n = out.length;
    if (n < 2 || !out.some((id) => this.pairOf(this.stations.get(id)))) return out;
    const len = (from: Station, to: Station) => {
      const r = this.roads.route(from.nodeId, to.nodeId);
      return r ? this.roads.routeLength(r) : Infinity;
    };
    // Два прохода: первая остановка смотрит на последнюю, а та могла смениться.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const st = this.stations.get(out[i]);
        const mate = this.pairOf(st);
        const prev = this.stations.get(out[(i - 1 + n) % n]);
        if (!st || !mate || !prev || prev.id === mate.id || prev.kind === 'rail') continue;
        if (prev.id === st.id) {
          if (n > 2) out[i] = mate.id;
          continue;
        }
        if (len(prev, mate) < len(prev, st) - 1) out[i] = mate.id;
      }
    }
    return out;
  }

  /**
   * Маршрут line по остановкам stops — той же длины, где половина пары заменена другой (пара сложилась или
   * распалась): соседние одинаковые склеиваются, машины едут к той же по счёту остановке — уже к её новой половине
   * (стоящая у прежней уезжает оттуда, её место у остановки — за новой). Короче двух остановок — false, ничего не меняется.
   */
  private remapLine(line: Line, stops: readonly number[]): boolean {
    const merged = mergeStops(stops);
    if (!merged) return false;
    const before = line.stops;
    if (merged.stops.length === before.length && merged.stops.every((id, i) => id === before[i])) return true;
    const rules = line.rules;
    const keep = merged.index.map((to, from) => (merged.index.indexOf(to) === from ? from : -1)).filter((i) => i >= 0);
    line.stops = merged.stops;
    if (rules) line.rules = keep.map((i) => rules[i] ?? null);
    delete line.lap;
    delete line.departedAt;
    this.lapGuess.delete(line.id);
    for (const vid of line.vehicles) {
      const v = this.fleet.get(vid);
      if (!v) continue;
      this.forgetLap(v);
      const was = this.stations.get(before[v.stop]);
      if (was) this.remapLineVehicle(v, line, was, merged.index[v.stop] ?? 0);
      else v.stop = merged.index[v.stop] ?? 0;
    }
    this.journal.add('route', { id: line.id, stops: line.stops, was: before });
    return true;
  }

  /**
   * Машина v линии line ехала к остановке was (или стояла у неё), теперь это остановка номер index — другая половина
   * той же пары: место у остановки — за новой, а едет она уже к новой.
   */
  private remapLineVehicle(v: FleetVehicle, line: Line, was: Station, index: number): void {
    v.stop = index;
    const now = this.stations.get(line.stops[index]);
    if (!now || now.id === was.id) return;
    const i = was.occupied.indexOf(v.id);
    if (i >= 0) {
      was.occupied.splice(i, 1);
      now.occupied.push(v.id);
    }
    const sim = this.fleetSim(v);
    if (sim && v.state === 'driving' && !v.boarding && sim.targetNode === was.nodeId) this.traffic.redirect(sim, now.nodeId);
  }

  /** К узлу можно примкнуть выезд станции: перекрёсток или тупик обычных дорог на земле (не выезд другой станции). */
  private stationJoinable(n: LaneNode): boolean {
    const net = this.roads.net;
    if (n.level !== 0 || (n.roundabout ?? null) !== null || !n.corridors.length) return false;
    if (n.kind !== 'junction' && !net.isDeadEnd(n)) return false;
    if ([...this.stations.values()].some((st) => st.kind !== 'dock' && st.nodeId === n.id)) return false;
    // Выезд другой станции — шоссе, но к узлу на нём пристроиться можно, как к улице.
    const driveways = this.drivewayIds();
    return n.corridors.every((sid) => {
      const s = net.corridor(sid);
      return !s.ring && (!isTrunk(s.cls) || driveways.has(sid));
    });
  }

  /**
   * Станция у перекрёстка: выезд прямо из узла в свободный промежуток со стороны курсора —
   * лучше напротив одной из дорог или под прямым углом к ней, но не ближе STATION_JOIN_GAP к соседним.
   */
  private junctionStationPlan(node: LaneNode, p: Vec, len: number = STATION.driveway): StationPlan {
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
      const plan = this.drivewayStationPlan(from, { x: Math.cos(c.a), y: Math.sin(c.a) }, clearance, len);
      if (plan.ok) return plan;
      first ??= plan;
    }
    if (first) return first;
    // Места нет — силуэт к курсору (курсор над узлом — в самый широкий промежуток).
    const a = aim ?? options.reduce((x, y) => (gapTo(y.a) > gapTo(x.a) ? y : x), { a: 0 }).a;
    const fp = this.drivewayFootprint(node.pos, { x: Math.cos(a), y: Math.sin(a) }, clearance, len);
    return { ok: false, reason: 'У перекрёстка нет места для выезда', cost: COST.station, fp };
  }

  /**
   * Площадка автостанции в конце выезда от from по dir (clearance — отступ от оси дороги, len — длина выезда от него):
   * длинной стороной к выезду.
   */
  private drivewayFootprint(from: Vec, dir: Vec, clearance: number, len: number = STATION.driveway): Footprint {
    const center = add(from, scale(dir, clearance + len + STATION.gate + STATION.size.h / 2));
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
  private drivewayStationPlan(from: Anchor, dir: Vec, clearance: number, len: number = STATION.driveway): StationPlan {
    const nodePos = add(from.pos, scale(dir, clearance + len));
    const fp = this.drivewayFootprint(from.pos, dir, clearance, len);
    const plan = this.roadBuilder.road(from, { kind: 'free', pos: nodePos }, DRIVEWAY);
    const fail = (reason: string, cost = plan.cost + COST.station): StationPlan => ({ ok: false, reason, cost, fp, driveway: plan, from, drivewayLen: len });
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
    return { ok: true, cost, fp, driveway: plan, from, nodePos, demolish, drivewayLen: len };
  }

  placeStation(
    p: Vec,
    snapRadius: number,
    kind: StationKind = 'road',
    serves: StationServes = ALL_SERVICES,
    angle = 0,
    tracks = 2,
    platform: number = RAIL_STATION.platform,
    terminal = false,
    road: RoadStationOptions = {},
  ): Station | null {
    const plan = this.stationPlan(p, snapRadius, kind, angle, tracks, platform, terminal, road);
    if (!plan.ok || !plan.fp) return null;
    const id = this.nextEntityId++;
    let nodeId = -1;
    let platforms: number[] = [];
    if (plan.rail) {
      // Главный путь в чистом поле оплачивает строитель — доплачиваем остальное.
      const before = this.money;
      platforms = this.buildRailStation(id, plan.rail);
      // Вокзал на один путь — платформа только на главном.
      if (!platforms.length) return null;
      this.spend(plan.cost - (before - this.money));
    } else {
      if (kind === 'road' && !plan.side && !plan.curb && plan.driveway?.net && plan.nodePos) keepMainRoad(plan.driveway.net, plan.nodePos);
      if (!plan.driveway || !plan.nodePos || !this.roadBuilder.apply(plan.driveway)) return null;
      // Узел станции — тупик выезда (у остановки и станции вдоль дороги — стык посреди улицы).
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
    // Остановка — только для пассажиров; станция у предприятия — с грузом, даже если выбран автовокзал.
    const given = this.stationServesFor(plan.fp, kind, plan.industryId, serves);
    const switched = kind !== 'stop' && given.cargo && !serves.cargo;
    const st: Station = {
      type: 'station',
      id,
      kind,
      name: '',
      fp: plan.fp,
      nodeId,
      platforms,
      ...(plan.rail?.terminal ? { terminal: true } : {}),
      ...(plan.side ? { side: true } : {}),
      ...(plan.curb ? { curb: { pocket: plan.curb.pocket } } : {}),
      ...(plan.drivewayLen !== undefined ? { driveway: plan.drivewayLen } : {}),
      serves: given,
      industryId: ind?.id ?? null,
      cargo: {},
      passengers: new Map(),
      occupied: [],
      bays: plan.rail ? platforms.length : kind === 'stop' ? STOP.bays : (plan.curb?.bays ?? STATION.bays),
      townIds: [],
      industryIds: [],
      accepts: new Set(),
      catchPop: 0,
      paxAcc: 0,
    };
    this.computeCatchment(st);
    // Половина пары — под тем же названием, что и остановка напротив.
    const mate = plan.pair !== undefined ? this.stations.get(plan.pair) : undefined;
    st.name = mate ? mate.name : this.stationName(st, ind);
    this.stations.set(id, st);
    this.stationRev++;
    this.index.add(st);
    if (mate) this.pairStops(st, mate);
    this.journal.add('station', {
      id,
      name: st.name,
      kind: st.kind,
      serves: `${st.serves.pax ? 'пассажиры' : ''}${st.serves.pax && st.serves.cargo ? '+' : ''}${st.serves.cargo ? 'груз' : ''}`,
      pos: [Math.round(st.fp.center.x), Math.round(st.fp.center.y)],
      towns: st.townIds,
      inds: st.industryIds,
      pop: st.catchPop,
      accepts: [...st.accepts],
      ...(switched ? { auto: 'груз' } : {}),
    });
    if (switched) this.notify(`${st.name}: станция у предприятия — работает с грузом`);
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
   * Своё название станции: пробелы по краям обрезаются, пустое не принимается.
   * Названия маршрутов через неё, которые игрок не менял (так и остались «Откуда — Куда»), следуют за ним.
   */
  renameStation(id: number, name: string): void {
    const st = this.stations.get(id);
    const clean = name.trim().slice(0, 40);
    if (!st || !clean || clean === st.name) return;
    // У пары остановок название одно на обе половины.
    const halves = [st, ...[this.pairOf(st)].filter((s): s is Station => !!s)];
    const auto = [...this.lines.values()].filter((l) => halves.some((h) => l.stops.includes(h.id)) && l.name === this.defaultLineName(l.stops));
    for (const h of halves) h.name = clean;
    for (const line of auto) line.name = this.defaultLineName(line.stops);
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
    if (g.terminal) return this.buildTerminalStation(id, g.terminal, g.tracks, cur);
    if (!g.cuts) return [];
    const cuts = g.cuts;
    const nodes: number[] = [];
    let platform1 = -1;
    // Режем с дальнего конца: начальная часть сохраняет отсчёт длины от начала пути.
    for (let k = 3; k >= 0; k--) {
      const s = net.segment(cur);
      const res = net.splitSegmentDetailed(cur, s.lut.tAt(cuts[k]));
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
      if (up) net.addSegment(b.id, j1, up, RAIL_SPEC);
      p.platform = id;
      platforms.push(p.id);
    }
    this.networkChanged();
    return platforms;
  }

  /**
   * Конечная: режет главный путь у горловины и в начале платформы; его конец — упор первой платформы.
   * Остальные пути — съезд от стрелки горловины и платформа до своего упора (тупика). Узлы платформ
   * принадлежат вокзалу: тупики-упоры нельзя продлить, пока стоит станция.
   */
  private buildTerminalStation(id: number, ends: NonNullable<RailStationGeom['terminal']>, tracks: RailStationGeom['tracks'], segId: number): number[] {
    const net = this.net;
    const seg = net.segment(segId);
    const at = { throat: seg.lut.closest(ends.throat).s, start: seg.lut.closest(ends.start).s };
    // Режем с дальнего от начала участка места: начальная часть сохраняет отсчёт длины.
    const order = (Object.keys(at) as (keyof typeof at)[]).sort((x, y) => at[y] - at[x]);
    const node = { throat: -1, start: -1 };
    let cur = segId;
    for (const k of order) {
      const s = net.segment(cur);
      const res = net.splitSegmentDetailed(cur, s.lut.tAt(at[k]));
      node[k] = res.node.id;
      cur = res.first.id;
    }
    const j0 = node.throat;
    const a1 = node.start;
    const other = (sid: number, from: number) => {
      const s = net.segment(sid);
      return s.a === from ? s.b : s.a;
    };
    const platform1 = net.node(a1).segments.find((sid) => other(sid, a1) !== j0);
    if (platform1 === undefined) return [];
    const buffer = other(platform1, a1);
    net.node(a1).buildingId = id;
    net.node(buffer).buildingId = id;
    net.segment(platform1).platform = id;
    const platforms = [platform1];
    for (const [down, platform] of tracks) {
      const a = net.addNode(down.p3, 0, id);
      const b = net.addNode(platform.p3, 0, id);
      net.addSegment(j0, a.id, down, RAIL_SPEC);
      const p = net.addSegment(a.id, b.id, platform, RAIL_SPEC);
      p.platform = id;
      platforms.push(p.id);
    }
    this.networkChanged();
    return platforms;
  }

  removeStation(st: Station): boolean {
    // Половина пары: маршруты через неё встают у второй половины — она остаётся обычной остановкой.
    const mate = this.pairOf(st);
    if (mate) {
      const lines = this.stationLines(st.id);
      const swapped = lines.map((l) => l.stops.map((id) => (id === st.id ? mate.id : id)));
      if (swapped.every((s) => mergeStops(s))) {
        this.unpairStop(st);
        lines.forEach((l, i) => this.remapLine(l, swapped[i]));
        this.handPax(st, mate);
      }
    }
    if (this.stationLines(st.id).length) {
      this.notify('Станцию используют маршруты — сначала удалите их');
      return false;
    }
    this.journal.add('station-', { id: st.id, name: st.name });
    this.index.remove(st);
    this.stations.delete(st.id);
    this.stationRev++;
    // Станция у получателя невидима и ничего не стоила: улица и двор магазина остаются.
    if (st.kind === 'dock') return true;
    if (st.kind === 'rail') {
      this.removeRailStation(st);
      this.refund(railStationFee(st.platforms.length, this.net.segments.get(st.platforms[0])?.length ?? RAIL_STATION.platform));
      this.networkChanged();
      return true;
    }
    // Остановка стоит прямо на улице — улица остаётся.
    if (st.kind === 'stop') {
      this.refund(STOP.cost);
      return true;
    }
    // Выезд станции сносится вместе с ней; у станции вдоль дороги выезда нет — улица и карман остаются.
    const node = this.roads.net.nodes.get(st.nodeId);
    if (node?.corridors.length && !st.side && !st.curb) {
      const plan = this.roadBuilder.bulldoze([...node.corridors]);
      if (plan.net) this.roadBuilder.apply({ ...plan, ok: true });
    }
    // Добавленные посты погрузки и склады тоже возвращают часть цены; склады-здания сносятся вместе со станцией.
    for (const w of st.warehouses ?? []) this.index.remove(w);
    this.refund(COST.station + Math.max(0, st.bays - STATION.bays) * STATION.bayCost + storageSlots(st) * STORAGE.cost);
    this.networkChanged();
    return true;
  }

  /**
   * Сносят половину пары from: пассажиры, что ждали на ней, переходят на оставшуюся to, а кто ехал или ждал до неё —
   * едут до оставшейся (между половинами одной пары никто не ездит).
   */
  private handPax(from: Station, to: Station): void {
    for (const [sid, n] of from.passengers) if (sid !== to.id) to.passengers.set(sid, (to.passengers.get(sid) ?? 0) + n);
    from.passengers.clear();
    for (const st of this.stations.values()) {
      const n = st.passengers.get(from.id);
      if (n === undefined) continue;
      st.passengers.delete(from.id);
      if (st.id !== to.id) st.passengers.set(to.id, (st.passengers.get(to.id) ?? 0) + n);
    }
    for (const v of this.fleet.values()) {
      for (const g of v.passengers) {
        if (g.to === from.id) g.to = to.id;
        if (g.from === from.id) g.from = to.id;
      }
    }
  }

  /** Станция, которую сейчас примеряют на новое место: её саму при проверках места не считаем. */
  private movingStation: number | null = null;

  /**
   * Перенос станции в точку p — место, выезд и прилипание как при постройке (stationPlan), только без самой
   * станции и её старого выезда (он снесётся, как при сносе станции; стык остановки на улице остаётся).
   * Цена — постройка на новом месте минус возврат за снос старой станции и её выезда. Ж/д станция переносится
   * с теми же путями и длиной платформ, конечной или проходной — как в rail (railMovePlan).
   */
  stationMovePlan(id: number, p: Vec, snapRadius: number, rail: RailMoveOptions = {}): StationPlan & { refund: number } {
    const st = this.stations.get(id);
    if (!st) return { ok: false, reason: 'Станции нет', cost: 0, fp: null, refund: 0 };
    if (st.kind === 'rail') return this.railMovePlan(st, p, snapRadius, rail);
    // Как стояла, так и встанет: вдоль дороги или в конце выезда той же длины.
    const road: RoadStationOptions = st.curb ? { curb: true, curbBays: st.bays } : st.side ? { side: true } : { driveway: st.driveway ?? STATION.driveway };
    return this.relocatePlan(st, () => this.stationPlan(p, snapRadius, st.kind, 0, 2, RAIL_STATION.platform, false, road));
  }

  /**
   * Другая длина выезда станции id (м от кромки дороги): тот же выезд из того же места дороги и в ту же сторону,
   * станция — в его конце. Только у станции в конце выезда (не вдоль дороги и не у грузового двора предприятия).
   */
  stationDrivewayPlan(id: number, len: number): StationPlan & { refund: number } {
    const st = this.stations.get(id);
    const none = (reason: string): StationPlan & { refund: number } => ({ ok: false, reason, cost: 0, fp: st?.fp ?? null, refund: 0 });
    if (!st || st.kind !== 'road') return none('Выезд есть только у автостанции');
    if (st.side || st.curb) return none('Станция вдоль дороги — без выезда');
    if (st.industryId !== null) return none('Грузовой двор стоит вплотную к предприятию');
    const net = this.roads.net;
    const node = net.nodes.get(st.nodeId);
    const c = node && node.corridors.length === 1 ? net.corridor(node.corridors[0]) : null;
    if (!node || !c) return none('Нельзя');
    const exit = net.node(c.a === node.id ? c.b : c.a);
    const d = sub(node.pos, exit.pos);
    const l = Math.hypot(d.x, d.y) || 1;
    const dir = { x: d.x / l, y: d.y / l };
    const want = clampDriveway(len);
    return this.relocatePlan(
      st,
      () => {
      // Выезд уже снесён: примыкаем там же — к узлу, если он остался (перекрёсток, тупик), иначе к полотну.
      const n2 = this.roads.net.nodesNear(exit.pos, 1)[0];
      if (n2 && n2.corridors.length) {
        const ends = this.roads.net.ends(n2);
        // От перекрёстка и тупика — с запасом, как у станции у перекрёстка; от стыка посреди улицы — как от полотна.
        const straight = ends.length === 2 && dot(ends[0].away, ends[1].away) < -0.85;
        const junction = !straight && (n2.kind === 'junction' || this.roads.net.isDeadEnd(n2));
        const clearance = Math.max(...ends.map((e) => corridorHalf(e.corridor))) + (junction ? 6 : 0);
        return this.drivewayStationPlan({ kind: 'node', node: n2.id, pos: n2.pos }, dir, clearance, want);
      }
      const hit = this.streetNear(exit.pos, 4) ?? this.roadNear(exit.pos, 4, () => true);
      if (!hit) return { ok: false, reason: 'Нельзя', cost: 0, fp: st.fp };
      const from: Anchor = { kind: 'corridor', corridor: hit.seg.id, s: hit.s, pos: hit.seg.lut.pointAt(hit.s) };
      return this.drivewayStationPlan(from, dir, halfAtS(hit.seg, hit.s), want);
      },
      true,
    );
  }

  /**
   * Длина выезда станции, м от кромки дороги: какую выбрал игрок, а у старых станций — по самому выезду (его длина
   * без полуширины дороги, к которой он примыкает). Выезда нет (вдоль дороги, грузовой двор) — null.
   */
  stationDrivewayLen(st: Station): number | null {
    if (st.kind !== 'road' || st.side || st.curb || st.industryId !== null) return null;
    if (st.driveway !== undefined) return st.driveway;
    const net = this.roads.net;
    const node = net.nodes.get(st.nodeId);
    const c = node && node.corridors.length === 1 ? net.corridor(node.corridors[0]) : null;
    if (!node || !c) return null;
    const exit = net.node(c.a === node.id ? c.b : c.a);
    const half = Math.max(0, ...net.ends(exit).filter((e) => e.corridor.id !== c.id).map((e) => corridorHalf(e.corridor)));
    return Math.round(c.length - half);
  }

  /** Меняет длину выезда станции (одним шагом для Ctrl+Z). Возвращает причину, если нельзя. */
  setStationDriveway(id: number, len: number): string | null {
    const st = this.stations.get(id);
    const plan = this.stationDrivewayPlan(id, len);
    if (!st || !plan.ok) return plan.reason ?? 'Нельзя';
    return this.applyRelocation(st, plan, 'выезд станции');
  }

  /**
   * Примерка станции st на новом месте (make — план постройки): без самой станции и её старого выезда (он снесётся,
   * как при сносе станции; стык остановки и станции вдоль дороги на улице остаётся). Цена — постройка на новом месте
   * минус возврат за снос старой станции и её выезда; добавленные посты и склады переезжают с ней.
   * keep — станция остаётся, меняется только выезд (длина выезда): за станцию ни платы, ни возврата, а за выезд —
   * только разница: длиннее — доплата за прибавку, короче — возврат половины цены убранного куска.
   */
  private relocatePlan(st: Station, make: () => StationPlan, keep = false): StationPlan & { refund: number; keep?: boolean } {
    const node = this.roads.net.nodes.get(st.nodeId);
    const old = st.kind === 'road' && !st.side && !st.curb && node?.corridors.length ? this.roadBuilder.bulldoze([...node.corridors]) : null;
    const base = st.kind === 'stop' ? STOP.cost : COST.station;
    // Возврат: старая станция (без добавленных постов — они переезжают вместе с ней) и её выезд.
    let refund = Math.round((base + (old?.refund ?? 0)) * COST.refundRatio);
    const net = this.roads.net;
    this.index.remove(st);
    this.movingStation = st.id;
    if (old?.net) this.roads.net = old.net;
    try {
      const plan = make();
      let cost = plan.cost;
      if (keep) {
        // Выезд стал длиннее — платим только прибавку; короче — возврат половины цены убранного куска.
        const was = old?.refund ?? 0;
        const now = plan.driveway?.cost ?? 0;
        refund = Math.round(Math.min(was, now) + Math.max(0, was - now) * COST.refundRatio);
        cost -= base;
      }
      const fail = (reason: string) => ({ ...plan, ok: false, reason, refund, keep });
      if (!plan.ok || !plan.fp) return { ...plan, refund, keep };
      let fp = plan.fp;
      const demolish = [...(plan.demolish ?? [])];
      // Добавленные посты переезжают вместе со станцией: площадка шире — дома под ней сносим, прочее мешает.
      const extra = st.kind === 'road' && !st.curb ? (st.bays - STATION.bays) * STATION.bayWidth + (st.depots ?? 0) * STORAGE.width : 0;
      if (extra) {
        fp = { ...fp, w: fp.w + extra };
        const own = plan.industryId !== undefined ? this.industries.find((i) => i.id === plan.industryId) : undefined;
        for (const s of this.index.near(fp.center, footprintRadius(fp) + 120)) {
          if (s === own || !footprintsOverlap(fp, s.fp, 1) || demolish.includes(s.id) || plan.driveway?.demolish.includes(s.id)) continue;
          if (s.type !== 'building' || s.kind === 'landmark') return fail(s.type === 'industry' ? 'Мешает предприятие' : 'Мешает здание');
          demolish.push(s.id);
          cost += this.demolishCost(s.id);
        }
        const road = this.roadUnder(fp, 2);
        if (road) return fail(road);
      }
      return { ...plan, fp, demolish, cost: cost - refund, refund, keep };
    } finally {
      this.roads.net = net;
      this.movingStation = null;
      this.index.add(st);
    }
  }

  /**
   * Переносит станцию (id, имя, пассажиры, груз, посты и маршруты — те же). Машины, что едут к ней, едут
   * к новому месту; стоящие на ней уезжают уже оттуда. Возвращает причину, если не получилось.
   */
  moveStation(id: number, p: Vec, snapRadius: number, rail: RailMoveOptions = {}): string | null {
    const st = this.stations.get(id);
    if (st?.kind === 'rail') return this.moveRailStation(st, p, snapRadius, rail);
    const plan = this.stationMovePlan(id, p, snapRadius);
    if (!st || !plan.ok) return plan.reason ?? 'Нельзя перенести';
    return this.applyRelocation(st, plan);
  }

  /**
   * Ставит станцию st по плану переноса (relocatePlan): новый выезд (или стык на улице), снос домов, деньги; машины,
   * что едут к ней, едут к новому месту. checkpoint — подпись шага для Ctrl+Z, если это отдельное действие игрока.
   */
  private applyRelocation(st: Station, plan: StationPlan & { refund: number; keep?: boolean }, checkpoint?: string): string | null {
    if (!plan.ok || !plan.fp || !plan.driveway?.net || !plan.nodePos) return plan.reason ?? 'Нельзя перенести';
    if (checkpoint) this.checkpoint(checkpoint);
    // Узел на новом месте уже есть в сети плана: машины к станции едут туда (иначе потеряли бы дорогу).
    const node = plan.driveway.net.nodesNear(plan.nodePos, 2)[0];
    if (!node) return 'Нельзя перенести';
    const oldNode = st.nodeId;
    for (const v of this.fleet.values()) {
      const line = this.lines.get(v.lineId);
      const sim = this.fleetSim(v);
      if (line && sim && line.stops[v.stop] === st.id && !v.boarding && sim.targetNode === st.nodeId) sim.targetNode = node.id;
    }
    this.index.remove(st);
    // Новая сеть — без старого выезда, с новым (или со стыком остановки на новой улице); дома под выездом сносит строитель.
    if (st.kind === 'road' && !plan.side && !plan.curb) keepMainRoad(plan.driveway.net, plan.nodePos);
    if (!this.roadBuilder.apply(plan.driveway)) {
      this.index.add(st);
      return 'Нельзя перенести';
    }
    if (plan.demolish?.length) {
      const cost = this.demolishTotal(plan.demolish);
      this.demolish(plan.demolish);
      this.spend(cost);
    }
    // Меняется только выезд — станция та же: за неё не платим.
    if (!plan.keep) this.spend(st.kind === 'stop' ? STOP.cost : COST.station);
    this.money += plan.refund;
    this.incomeMonth += plan.refund;
    this.ledger.sales += plan.refund;
    st.fp = plan.fp;
    st.nodeId = node.id;
    this.stationRev++;
    st.industryId = plan.industryId ?? null;
    if (plan.curb) st.curb = { pocket: plan.curb.pocket };
    if (plan.drivewayLen !== undefined) st.driveway = plan.drivewayLen;
    this.index.add(st);
    this.computeCatchment(st);
    if (st.kind === 'stop') this.pairAfterMove(st, oldNode, plan.pair);
    if (checkpoint) this.commit();
    return null;
  }

  /**
   * Остановку st перенесли (прежний узел — oldNode): уехала от своей пары дальше STOP.pair.reach — пара распалась,
   * у перенесённой — своё название; встала напротив другой (или снова своей) — пара с ней, название — её.
   */
  private pairAfterMove(st: Station, oldNode: number, pair: number | undefined): void {
    // Прежний стык остаётся на улице — уже не цель с одной стороны.
    const old = this.roads.net.nodes.get(oldNode);
    if (old) delete old.arrive;
    const was = this.pairOf(st);
    const mate = pair !== undefined ? this.stations.get(pair) : undefined;
    if (was && was !== mate) {
      this.unpairStop(st);
      if (st.name === was.name) this.renameStation(st.id, this.stationName({ ...st, name: '' }, undefined));
    }
    if (!mate) return;
    if (mate !== was) this.renameStation(st.id, mate.name);
    this.pairStops(st, mate);
  }

  /** Пути без вокзала st (копия сети) — для примерки переноса; пересчитываются, только когда сеть поменялась. */
  private railMoveBase: { id: number; version: number; net: Network; worth: number } | null = null;

  /**
   * Пути, какими они станут, если разобрать вокзал st: боковые пути со съездами прочь, главный путь в местах,
   * где его резала станция, снова цельный — на его месте можно поставить станцию другого типа. worth — цена
   * разобранных путей (за них — возврат, как при сносе станции).
   */
  private railsWithout(st: Station): { net: Network; worth: number } {
    const c = this.railMoveBase;
    if (c && c.id === st.id && c.version === this.net.version) return c;
    const net = cloneNetwork(this.net);
    const { worth, cuts } = stripRailStation(net, st, (s) => this.builder.segmentCost(s));
    healCuts(net, cuts);
    net.rebuild();
    this.railMoveBase = { id: st.id, version: this.net.version, net, worth };
    return this.railMoveBase;
  }

  /** Возврат за снос вокзала st: здание и платформы, боковые пути со съездами (их цена — worth). */
  private railRefund(st: Station, worth: number): number {
    const length = clampRailLength(this.net.segments.get(st.platforms[0])?.length ?? RAIL_STATION.platform);
    return Math.round((railStationFee(st.platforms.length, length) + worth) * COST.refundRatio);
  }

  /**
   * Перенос ж/д станции в точку p: та же постановка, что у новой (railStationPlan) — на прямой путь, к тупику
   * (конечная) или в чистое поле, — но на путях без самой станции (railsWithout): так её можно поставить и на
   * прежнее место, сменив тип. Путей и длина платформ — как были; terminal — конечной или проходной она станет
   * (по умолчанию — какой была). Цена — новая станция минус возврат за снос старой; возврат идёт и в бюджет.
   */
  private railMovePlan(st: Station, p: Vec, snapRadius: number, opts: RailMoveOptions): StationPlan & { refund: number } {
    const { net, worth } = this.railsWithout(st);
    const refund = this.railRefund(st, worth);
    const length = clampRailLength(this.net.segments.get(st.platforms[0])?.length ?? RAIL_STATION.platform);
    const terminal = opts.terminal ?? !!st.terminal;
    const real = this.net;
    const money = this.money;
    const self = this as unknown as { net: Network };
    this.index.remove(st);
    self.net = net;
    this.money = money + refund;
    try {
      const plan = this.railStationPlan(p, snapRadius, opts.angle ?? 0, st.platforms.length, length, terminal);
      return { ...plan, cost: plan.cost - refund, refund };
    } finally {
      this.money = money;
      self.net = real;
      this.index.add(st);
    }
  }

  /**
   * Переносит ж/д станцию (id, имя, пассажиры, груз и маршруты — те же; правила «на какой путь» — по номеру пути):
   * старые боковые пути разбираются, главный срастается, на новом месте строится станция с тем же числом путей.
   * Поезда на разобранных путях встают на платформу заново, как после сноса путей под ними.
   */
  private moveRailStation(st: Station, p: Vec, snapRadius: number, opts: RailMoveOptions): string | null {
    const check = this.railMovePlan(st, p, snapRadius, opts);
    if (!check.ok) return check.reason ?? 'Нельзя перенести';
    const tracks = st.platforms.length;
    const length = clampRailLength(this.net.segments.get(st.platforms[0])?.length ?? RAIL_STATION.platform);
    const terminal = opts.terminal ?? !!st.terminal;
    const from = st.fp.center;
    const saved = structuredClone(this.net.serialize());
    const money = this.money;
    const { worth, cuts } = stripRailStation(this.net, st, (s) => this.builder.segmentCost(s));
    const refund = this.railRefund(st, worth);
    healCuts(this.net, cuts);
    this.index.remove(st);
    this.money = money + refund;
    const plan = this.railStationPlan(p, snapRadius, opts.angle ?? 0, tracks, length, terminal);
    const before = this.money;
    const platforms = plan.ok && plan.rail && plan.fp ? this.buildRailStation(st.id, plan.rail) : [];
    if (!plan.fp || !platforms.length) {
      // Не вышло (сеть оказалась не такой, как при примерке): всё как было.
      this.money = money;
      this.net.replaceWith(saved);
      this.networkChanged();
      this.index.add(st);
      return plan.reason ?? 'Нельзя перенести';
    }
    this.incomeMonth += refund;
    this.ledger.sales += refund;
    this.spend(plan.cost - (before - this.money));
    st.fp = plan.fp;
    st.platforms = platforms;
    if (plan.rail?.terminal) st.terminal = true;
    else delete st.terminal;
    st.bays = platforms.length;
    this.stationRev++;
    this.index.add(st);
    this.computeCatchment(st);
    this.railMoveBase = null;
    this.journal.add('station>', {
      id: st.id,
      name: st.name,
      from: [Math.round(from.x), Math.round(from.y)],
      pos: [Math.round(st.fp.center.x), Math.round(st.fp.center.y)],
      ...(st.terminal ? { terminal: 1 } : {}),
    });
    return null;
  }

  /**
   * Достроить ж/д вокзалу ещё один путь с платформой: рядом с крайним, со стороны здания (здание отодвигается
   * на путь дальше, у конечной — в торце становится шире), съезды — от стрелок горловины (extraTrackGeom).
   * Не помещается со стороны здания (мешают дома, пути, дороги, вода, край карты) — за крайним путём с другой
   * стороны, здание остаётся на месте. side — только эта сторона.
   * Цена — путь и прибавка к цене вокзала за платформу (railStationFee). Мешают — как при постановке станции.
   */
  railTrackPlan(id: number, side?: TrackSide): RailTrackPlan {
    if (side) return this.railTrackPlanAt(id, side);
    const near = this.railTrackPlanAt(id, 1);
    // Со стороны здания не хватает только денег, или пути не проложить вовсе (нет геометрии) — другая сторона не поможет.
    if (near.ok || !near.geom || near.reason === 'Не хватает денег') return near;
    const far = this.railTrackPlanAt(id, -1);
    return far.ok ? far : near;
  }

  private railTrackPlanAt(id: number, side: TrackSide): RailTrackPlan {
    const st = this.stations.get(id);
    if (!st) return { ok: false, reason: 'Станции нет', cost: 0, fp: null };
    if (st.kind !== 'rail') return { ok: false, reason: 'Пути с платформами — только у ж/д станции', cost: 0, fp: st.fp };
    const k = st.platforms.length;
    if (k >= RAIL_STATION.maxTracks) return { ok: false, reason: `Больше ${RAIL_STATION.maxTracks} путей нельзя`, cost: 0, fp: st.fp };
    const shape = stationShape(this.net, st);
    if (!shape) return { ok: false, reason: 'Пути станции перестроены — новый не проложить', cost: 0, fp: st.fp };
    const geom = extraTrackGeom(this.net, st, shape, side);
    const L = clampRailLength(geom.platform);
    let length = 0;
    const samples: Vec[] = [];
    for (const c of geom.curves) {
      const lut = new CurveLUT(c);
      length += lut.length;
      for (let s = 8; s < lut.length; s += 8) samples.push(lut.pointAt(s));
    }
    const cost = Math.round(length * specCost(RAIL_SPEC)) + railStationFee(k + 1, L) - railStationFee(k, L);
    const fp = geom.fp;
    const fail = (reason: string): RailTrackPlan => ({ ok: false, reason, cost, fp, geom, side });
    // Здание остаётся, где стояло (проходная, путь с другой стороны), — его место не проверяем: оно уже его.
    const still = fp.w === st.fp.w && dist(fp.center, st.fp.center) < 0.01;
    // Свои пути не мешают: платформы, съезды к ним и главный путь у стрелок горловины (в том числе за ними).
    const net = this.net;
    const nodes = new Set<number>([...shape.switches.filter((x): x is number => x !== null)]);
    for (const n of net.nodes.values()) if (n.buildingId === st.id) nodes.add(n.id);
    const own = new Set<number>();
    for (const nid of nodes) for (const sid of net.node(nid).segments) own.add(sid);
    for (const b of geom.branches) if (b.split) own.add(b.split.seg);
    const blocker = this.railEditBlocker(st, samples, fp, still, own);
    if (blocker) return fail(blocker);
    if (cost > this.budget) return fail('Не хватает денег');
    return { ok: true, cost, fp, geom, side };
  }

  /**
   * Что мешает правке построенного вокзала st (новый путь, длиннее платформы): точки samples на новых путях
   * и здание fp на новом месте (still — здание стоит, где стояло, его место не проверяем). Свои пути own — не помеха.
   */
  private railEditBlocker(st: Station, samples: Vec[], fp: Footprint, still: boolean, own: Set<number>): string | null {
    const net = this.net;
    if ((!still && !this.inBounds(fp.center, 30)) || samples.some((q) => !this.inBounds(q, 20))) return 'За краем карты';
    if ((!still && this.isWater(fp.center, footprintRadius(fp) * 0.6)) || samples.some((q) => this.isWater(q, RAIL_HALF))) return 'Мешает вода';
    this.index.remove(st);
    try {
      if ((!still && this.index.overlaps(fp, 3)) || samples.some((q) => this.blocked(q, RAIL_HALF + 2))) return 'Мешает здание';
    } finally {
      this.index.add(st);
    }
    const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
    const v = { x: -u.y, y: u.x };
    const probes = [...samples];
    if (!still) for (let i = -2; i <= 2; i++) for (let j = -1; j <= 1; j++) probes.push(add(fp.center, add(scale(u, (i * fp.w) / 4), scale(v, (j * fp.h) / 2))));
    for (const q of probes) {
      for (const s of net.segmentsNear(q, 40)) {
        if (own.has(s.id)) continue;
        if (s.lut.closest(q).d < halfWidth(s.spec) + RAIL_HALF + 2) return isRail(s.spec) ? 'Мешает другой путь' : 'Мешает дорога';
      }
      for (const c of this.roads.net.corridorsNear(q, 60)) {
        const hit = c.lut.closest(q);
        if (hit.d < halfAtS(c, hit.s) + RAIL_HALF + 2) return 'Мешает дорога';
      }
    }
    return null;
  }

  /**
   * Удлинить платформы ж/д вокзала на шаг (RAIL_STATION.lengthStep, как у вариантов длины при постановке) — все пути
   * станции сразу, стрелки горловин отодвигаются (extendGeom). У проходной — поровну в обе стороны, не помещается —
   * весь шаг в одну. У конечной — в сторону горловины (здание в торце на месте), не выходит — от упоров (здание
   * отъезжает). Мешают — как при постановке станции (дома, пути, дороги, вода, край карты); причина — первого способа,
   * которому мешает что-то на месте, а не устройство путей. Цена — новые метры пути и прибавка к цене вокзала за длину.
   */
  railExtendPlan(id: number): RailExtendPlan {
    const R = RAIL_STATION;
    const st = this.stations.get(id);
    const none = (reason: string, length = 0): RailExtendPlan => ({ ok: false, reason, cost: 0, fp: st?.fp ?? null, length, next: length });
    if (!st) return none('Станции нет');
    if (st.kind !== 'rail') return none('Платформы удлиняются только у ж/д станции');
    const main = this.net.segments.get(st.platforms[0]);
    if (!main) return none('Пути станции перестроены — платформы не удлинить');
    const length = clampRailLength(main.length);
    const next = length + R.lengthStep;
    if (next > R.maxLength) return { ...none(`Платформы длиннее ${R.maxLength} м не бывают`, length), next: length };
    const shape = stationShape(this.net, st);
    if (!shape) return { ...none('Пути станции перестроены — платформы не удлинить', length), next };
    const step = next - main.length;
    const ways: [number, number][] = st.terminal
      ? [
          [step, 0],
          [0, step],
        ]
      : [
          [step / 2, step / 2],
          [step, 0],
          [0, step],
        ];
    const k = st.platforms.length;
    const fee = railStationFee(k, next) - railStationFee(k, length);
    let structural: RailExtendPlan | null = null;
    let blocked: RailExtendPlan | null = null;
    for (const shift of ways) {
      const geom = extendGeom(this.net, st, shape, shift);
      if (typeof geom === 'string') {
        structural ??= { ...none(geom, length), next };
        continue;
      }
      const samples: Vec[] = [];
      for (const c of geom.fresh) {
        const lut = new CurveLUT(c);
        for (let s = 4; s < lut.length; s += 8) samples.push(lut.pointAt(s));
      }
      const cost = Math.round(geom.added * specCost(RAIL_SPEC)) + fee;
      const still = geom.fp.w === st.fp.w && dist(geom.fp.center, st.fp.center) < 0.01;
      const blocker = this.railEditBlocker(st, samples, geom.fp, still, geom.own);
      const plan: RailExtendPlan = { ok: !blocker, reason: blocker ?? undefined, cost, fp: geom.fp, geom, length, next };
      if (!blocker) return cost > this.budget ? { ...plan, ok: false, reason: 'Не хватает денег' } : plan;
      blocked ??= plan;
    }
    return blocked ?? structural ?? none('Нельзя удлинить', length);
  }

  /** Удлиняет платформы ж/д вокзала на шаг (railExtendPlan): узлы и участки те же — поезда и маршруты остаются. */
  extendRailPlatforms(id: number): string | null {
    const plan = this.railExtendPlan(id);
    const st = this.stations.get(id);
    if (!plan.ok || !plan.geom || !plan.fp || !st) return plan.reason ?? 'Нельзя';
    this.checkpoint('длина платформ');
    const net = this.net;
    for (const [nid, p] of plan.geom.moves) net.moveNode(nid, p);
    for (const [sid, c] of plan.geom.curves) net.setCurve(sid, c);
    this.spend(plan.cost);
    this.index.remove(st);
    st.fp = plan.fp;
    this.index.add(st);
    this.computeCatchment(st);
    this.networkChanged();
    this.journal.add('station=', { id, name: st.name, length: plan.next, $: plan.cost });
    this.commit();
    return null;
  }

  /**
   * Достраивает ж/д вокзалу путь с платформой (railTrackPlan; side — только с этой стороны, без — где помещается);
   * поезда на станции и маршруты — как были.
   */
  addRailTrack(id: number, side?: TrackSide): string | null {
    const plan = this.railTrackPlan(id, side);
    const st = this.stations.get(id);
    if (!plan.ok || !plan.geom || !plan.fp || !st) return plan.reason ?? 'Нельзя';
    this.checkpoint('путь станции');
    const net = this.net;
    // Стрелки: существующие или новые — разрезом главного пути дальше от станции.
    const at = plan.geom.branches.map((b) => {
      if (b.node !== undefined || !b.split) return b.node!;
      const s = net.segment(b.split.seg);
      return net.splitSegmentDetailed(s.id, s.lut.tAt(b.split.s)).node.id;
    });
    const [down, platform, up] = plan.geom.curves;
    const a = net.addNode(down.p3, 0, id);
    const b = net.addNode(platform.p3, 0, id);
    net.addSegment(at[0], a.id, { ...down, p0: net.node(at[0]).pos }, RAIL_SPEC);
    const seg = net.addSegment(a.id, b.id, platform, RAIL_SPEC);
    seg.platform = id;
    if (up && at[1] !== undefined) net.addSegment(b.id, at[1], { ...up, p3: net.node(at[1]).pos }, RAIL_SPEC);
    this.spend(plan.cost);
    this.index.remove(st);
    st.platforms = [...st.platforms, seg.id];
    st.bays = st.platforms.length;
    this.stationRev++;
    st.fp = plan.fp;
    this.index.add(st);
    this.computeCatchment(st);
    this.networkChanged();
    this.journal.add('station+', { id, name: st.name, tracks: st.platforms.length, $: plan.cost });
    this.commit();
    return null;
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
    if (st.curb) return { ok: false, reason: `Мест у края улицы — ${st.bays}: их выбирают при постановке (или переставьте вокзал)`, cost: 0, fp: st.fp };
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

  /**
   * Пристройки-склады автостанции: каждая добавляет места под груз (STORAGE.per) и удлиняет площадку на
   * STORAGE.width — по половине с обоих концов, как посты. Где растёт — проверяем, как у постов: вода, дома,
   * предприятия, другие станции, дороги, край карты. Убрать можно всегда, если груз поместится на меньший склад.
   */
  stationDepotsPlan(id: number, depots: number): BaysPlan {
    const st = this.stations.get(id);
    if (!st) return { ok: false, reason: 'Станции нет', cost: 0, fp: null };
    if (st.kind !== 'road') return { ok: false, reason: st.kind === 'rail' ? 'У ж/д станции склад пока не растёт' : 'У остановки склада нет', cost: 0, fp: st.fp };
    const n = Math.round(depots);
    const extra = n - (st.depots ?? 0);
    const fp: Footprint = { ...st.fp, w: st.fp.w + extra * STORAGE.width };
    // Убираем — минус: refund вернёт часть цены (COST.refundRatio).
    const cost = extra * STORAGE.cost;
    const fail = (reason: string): BaysPlan => ({ ok: false, reason, cost, fp });
    if (n < 0) return fail('Пристроек нет');
    const houses = st.warehouses?.length ?? 0;
    if (n + houses > STORAGE.max) return fail(`Больше ${STORAGE.max} складов нельзя`);
    if (extra <= 0) {
      const stored = this.stationStored(st);
      const room = STORAGE.base + (n + houses) * STORAGE.per;
      return stored > room ? fail(`На складе ${Math.round(stored)} ед. — на меньший не поместится`) : { ok: true, cost, fp };
    }
    if (!this.inBounds(fp.center, footprintRadius(fp))) return fail('За краем карты');
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

  /** Добавляет или убирает пристройки-склады (одним шагом для Ctrl+Z). Возвращает причину, если не получилось. */
  setStationDepots(id: number, depots: number): string | null {
    const plan = this.stationDepotsPlan(id, depots);
    const st = this.stations.get(id);
    if (!plan.ok || !plan.fp || !st) return plan.reason ?? 'Нельзя';
    this.checkpoint('склад станции');
    if (plan.cost > 0) this.spend(plan.cost);
    else if (plan.cost < 0) this.refund(-plan.cost);
    this.index.remove(st);
    st.fp = plan.fp;
    st.depots = Math.round(depots);
    this.index.add(st);
    this.commit();
    return null;
  }

  /**
   * Склад-здание станции id с центром в p: только у автостанции, целиком в зоне вокруг неё (warehouseZone), не больше
   * STORAGE.max складов вместе с пристройками; мешают вода, дома, предприятия, станции, другие склады, дороги и пути.
   */
  warehousePlan(id: number, p: Vec): { ok: boolean; reason?: string; cost: number; fp: Footprint | null } {
    const st = this.stations.get(id);
    if (!st) return { ok: false, reason: 'Станции нет', cost: 0, fp: null };
    const cost = STORAGE.cost;
    const fp = warehouseFootprint(st, p);
    const fail = (reason: string) => ({ ok: false, reason, cost, fp });
    if (st.kind !== 'road') return fail(st.kind === 'rail' ? 'У ж/д станции склад пока не растёт' : 'У остановки склада нет');
    if (storageSlots(st) >= STORAGE.max) return fail(`Больше ${STORAGE.max} складов нельзя`);
    if (!inWarehouseZone(st, fp)) return fail('Склад — только рядом со станцией');
    const problem = this.outbuildingProblem(fp);
    if (problem) return fail(problem);
    if (cost > this.budget) return fail('Не хватает денег');
    return { ok: true, cost, fp };
  }

  /** Что мешает постройке рядом с хозяином (склад, пристройка): край карты, вода, здания и постройки, дороги и пути. */
  private outbuildingProblem(fp: Footprint): string | null {
    if (!this.inBounds(fp.center, footprintRadius(fp))) return 'За краем карты';
    if (this.isWater(fp.center, fp.h / 2) || footprintCorners(fp).some((c) => this.isWater(c))) return 'Мешает вода';
    for (const s of this.index.near(fp.center, footprintRadius(fp) + 120)) {
      if (!footprintsOverlap(fp, s.fp, 1)) continue;
      return s.type === 'building'
        ? 'Мешает здание'
        : s.type === 'industry'
          ? 'Мешает предприятие'
          : s.type === 'warehouse'
            ? 'Мешает склад'
            : s.type === 'annex'
              ? 'Мешает пристройка'
              : 'Мешает станция';
    }
    return this.roadUnder(fp, 2);
  }

  /**
   * Пристройка предприятия id с центром в p: только когда оно готово к расширению (annexReady), целиком в зоне вокруг
   * него; мешает то же, что складам станций.
   */
  annexPlan(id: number, p: Vec): { ok: boolean; reason?: string; cost: number; fp: Footprint | null } {
    const ind = this.industries.find((i) => i.id === id);
    if (!ind) return { ok: false, reason: 'Предприятия нет', cost: 0, fp: null };
    const cost = ANNEX.cost;
    const fp = annexFootprint(ind, p);
    const fail = (reason: string) => ({ ok: false, reason, cost, fp });
    if (!annexReady(ind)) return fail(`${ind.name} ещё не готово расти дальше`);
    if (!inAnnexZone(ind, fp)) return fail('Пристройка — только рядом с предприятием');
    const problem = this.outbuildingProblem(fp);
    if (problem) return fail(problem);
    if (cost > this.budget) return fail('Не хватает денег');
    return { ok: true, cost, fp };
  }

  /** Ставит пристройку предприятия id в точке p: уровень сразу +growthStep, предел роста +1. Причина, если нельзя. */
  buildAnnex(id: number, p: Vec): string | null {
    const plan = this.annexPlan(id, p);
    const ind = this.industries.find((i) => i.id === id);
    if (!plan.ok || !plan.fp || !ind) return plan.reason ?? 'Нельзя';
    this.checkpoint('пристройка предприятия');
    this.spend(plan.cost);
    const a: Annex = { type: 'annex', id: this.nextEntityId++, industryId: ind.id, fp: plan.fp };
    ind.annexes = [...(ind.annexes ?? []), a];
    this.index.add(a);
    const level = ind.level ?? 1;
    ind.level = Math.min(ind.cap ?? ECONOMY.maxLevel, level + ECONOMY.growthStep);
    ind.streak = 0;
    this.notify(`${ind.name}: пристройка — производство ×${ind.level}`, '#2e9d57');
    this.commit();
    return null;
  }

  /** Сносит пристройку (часть цены вернётся): предел роста −1, уровень — не выше него. */
  removeAnnex(a: Annex): void {
    const ind = this.industries.find((i) => i.id === a.industryId);
    this.checkpoint('снос пристройки');
    if (ind) {
      ind.annexes = (ind.annexes ?? []).filter((x) => x.id !== a.id);
      ind.level = Math.min(ind.level ?? 1, Math.max(1, growthCap(ind)));
    }
    this.index.remove(a);
    this.refund(ANNEX.cost);
    this.commit();
  }

  /** Ставит склад-здание станции id в точке p (одним шагом для Ctrl+Z). Возвращает причину, если нельзя. */
  buildWarehouse(id: number, p: Vec): string | null {
    const plan = this.warehousePlan(id, p);
    const st = this.stations.get(id);
    if (!plan.ok || !plan.fp || !st) return plan.reason ?? 'Нельзя';
    this.checkpoint('склад станции');
    this.spend(plan.cost);
    const w: Warehouse = { type: 'warehouse', id: this.nextEntityId++, stationId: st.id, fp: plan.fp };
    st.warehouses = [...(st.warehouses ?? []), w];
    this.index.add(w);
    this.commit();
    return null;
  }

  /** Снести склад-здание нельзя, если груз станции не поместится на меньший склад: причина, иначе null. */
  warehouseRemoveProblem(w: Warehouse): string | null {
    const st = this.stations.get(w.stationId);
    if (!st) return null;
    const stored = this.stationStored(st);
    return stored > this.stationStorage(st) - STORAGE.per ? `На складе ${Math.round(stored)} ед. — на меньший не поместится` : null;
  }

  /** Сносит склад-здание (часть цены вернётся). Возвращает причину, если нельзя. */
  removeWarehouse(w: Warehouse): string | null {
    const problem = this.warehouseRemoveProblem(w);
    if (problem) return problem;
    this.checkpoint('снос склада');
    const st = this.stations.get(w.stationId);
    if (st) st.warehouses = (st.warehouses ?? []).filter((x) => x.id !== w.id);
    this.index.remove(w);
    this.refund(STORAGE.cost);
    this.commit();
    return null;
  }

  /** Склады станций и пристройки предприятий — в пространственном индексе (после загрузки и Ctrl+Z — заново). */
  private indexWarehouses(): void {
    for (const s of [...this.index.items]) if (s.type === 'warehouse' || s.type === 'annex') this.index.remove(s);
    for (const st of this.stations.values()) for (const w of st.warehouses ?? []) this.index.add(w);
    for (const ind of this.industries) for (const a of ind.annexes ?? []) this.index.add(a);
  }

  /** Где посты автостанции: площадка без пристроек-складов по концам (они — по половине с обеих сторон). */
  bayArea(st: Station): Footprint {
    const depots = st.depots ?? 0;
    return depots ? { ...st.fp, w: st.fp.w - depots * STORAGE.width } : st.fp;
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

  /** Предприятия в охвате радиусом R вокруг точки at. */
  private industriesNear(at: Vec, R: number): Industry[] {
    return this.industries.filter((i) => dist(i.fp.center, at) < R + footprintRadius(i.fp) * 0.6);
  }

  /** Жители в охвате радиусом R вокруг точки at: какие города и сколько людей. */
  private peopleNear(at: Vec, R: number, mine: (p: Vec) => boolean = () => true): { towns: Set<number>; pop: number } {
    const towns = new Set<number>();
    let pop = 0;
    for (const town of this.towns) {
      if (dist(town.center, at) > (town.extent ?? town.radius) + R + 50) continue;
      for (const b of town.buildings) {
        if (dist(b.fp.center, at) > R || !mine(b.fp.center)) continue;
        towns.add(town.id);
        pop += b.kind === 'res' ? residentsOf(b) : b.floors * 6;
      }
    }
    return { towns, pop };
  }

  /**
   * С чем будет работать новая станция. Станция у предприятия — грузовая, даже если выбран автовокзал:
   * пристроенная к предприятию всегда берёт груз (пассажиров — только если рядом живут люди), а стоящая
   * рядом с предприятием без жителей в охвате — только грузовая. Иначе грузовики стояли бы у неё без груза.
   */
  stationServesFor(fp: Footprint, kind: StationKind, industryId: number | undefined, serves: StationServes): StationServes {
    if (kind === 'stop') return { pax: true, cargo: false };
    // Предприятию у станции не хватает рабочих (режим «Строит игрок»): станция сразу и для автобусов с рабочими.
    const ind = industryId !== undefined ? this.industries.find((i) => i.id === industryId) : undefined;
    const workers = !!ind && this.enterprises.busNeed(ind) > 0;
    if (serves.cargo) return { pax: serves.pax || workers, cargo: true };
    const R = this.catchmentRadius({ kind });
    const docked = industryId !== undefined;
    if (!docked && !this.industriesNear(fp.center, R).length) return { ...serves };
    const people = this.peopleNear(fp.center, R).pop > 0;
    if (people && !docked) return { ...serves };
    return { pax: (serves.pax && people) || workers, cargo: true };
  }

  computeCatchment(st: Station): void {
    if (st.kind === 'dock') {
      // Станция у получателя: только он сам — его город и что он принимает.
      const town = st.dock && this.towns.find((t) => t.id === st.dock!.town);
      const r = town && receiverOf(town, st.dock!.b);
      st.townIds = town ? [town.id] : [];
      st.industryIds = [];
      st.catchPop = 0;
      st.accepts = new Set(r?.cargo ?? []);
      return;
    }
    const R = this.catchmentRadius(st);
    st.industryIds = this.industriesNear(st.fp.center, R).map((i) => i.id);
    // Пара остановок: дом в охвате обеих половин — у ближней, жители пары не удваиваются.
    const mate = this.pairOf(st);
    const { towns, pop } = this.peopleNear(st.fp.center, R, mate ? (p) => nearerHalf(p, st, mate) === st.id : undefined);
    st.townIds = [...towns];
    // Пассажирская станция собирает жителей, грузовая принимает грузы. Стёртые переходы, где город хотел бы их, —
    // −5% жителей за каждый, не больше −20%: с той стороны улицы к остановке не идут (docs/CROSSWALKS.md).
    const missing = st.serves.pax && pop > 0 ? this.missingCrosswalks(st.fp.center, R) : 0;
    st.catchPop = st.serves.pax ? Math.round(pop * (1 - Math.min(WALK_LOSS.max, WALK_LOSS.each * missing))) : 0;
    st.accepts = new Set();
    if (!st.serves.cargo) return;
    for (const i of this.industries) if (st.industryIds.includes(i.id)) for (const c of i.info.accepts) st.accepts.add(c);
    if (!this.retail) {
      for (const t of this.towns) if (towns.has(t.id)) for (const c of t.demands) st.accepts.add(c);
      return;
    }
    // С получателями (world/retail.ts): город принимает только то, что берут получатели в охвате станции, и
    // потребности без получателей (топливо в городе без АЗС).
    for (const { r } of this.stationReceivers(st)) for (const c of r.cargo) st.accepts.add(c);
    for (const t of this.towns) if (towns.has(t.id)) for (const c of legacyCargo(t)) st.accepts.add(c);
  }

  /** Меняет, с чем работает станция: хотя бы что-то одно должно остаться. */
  setStationServes(id: number, serves: StationServes): void {
    const st = this.stations.get(id);
    if (!st || (!serves.pax && !serves.cargo)) return;
    st.serves = { ...serves };
    // Только пассажиры — автовокзал, а не грузовая станция: на карте — другое здание.
    this.stationRev++;
    if (!serves.pax) st.passengers.clear();
    if (!serves.cargo) st.cargo = {};
    this.computeCatchment(st);
    this.journal.add('serves', { st: id, pax: serves.pax, cargo: serves.cargo, pop: st.catchPop });
  }

  /**
   * Подсказки «что с чем соединять»: ближайшие потребители продукции и поставщики сырья.
   * direction 'out' — куда везти отсюда, 'in' — откуда везти сюда. Город с получателями груза (world/retail.ts) —
   * его магазины (рынок, АЗС…) по отдельности, у каждого — своё место и расстояние: везти — к ближайшим, а не в центр.
   */
  partners(target: Industry | Town, perCargo = 2): Partner[] {
    const result: Partner[] = [];
    const from = 'fp' in target ? target.fp.center : target.center;
    type Place = Omit<Partner, 'cargo' | 'direction' | 'distance'>;
    const places = (cargo: CargoType, c: Industry | Town): Place[] => {
      if ('fp' in c) return [{ pos: c.fp.center, name: c.info.name, ref: { type: 'industry', id: c.id } }];
      const shops = this.retail ? (c.receivers ?? []).filter((r) => !r.depot && r.cargo.includes(cargo)) : [];
      const out: Place[] = [];
      for (const r of shops) {
        const b = c.buildings.find((x) => x.id === r.b);
        if (!b) continue;
        const rc = roofCenter(b);
        out.push({ pos: lotFrame(b)(rc.x, rc.y), name: this.dockName(b), ref: { type: 'town', id: c.id }, b: b.id });
      }
      return out.length ? out : [{ pos: c.center, name: c.name, ref: { type: 'town', id: c.id } }];
    };
    const add = (cargo: CargoType, direction: 'in' | 'out', candidates: (Industry | Town)[]) => {
      candidates
        .flatMap((c) => places(cargo, c))
        .map((p) => ({ p, d: dist(from, p.pos) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, perCargo)
        .forEach(({ p, d }) => result.push({ cargo, direction, ...p, distance: d }));
    };
    // Заброшенные — не партнёры, пока их не восстановят; себя (предприятие на месте) не показываем.
    const live = this.industries.filter((i) => !i.ruin && i !== target);
    if ('fp' in target) {
      const product = target.info.produces;
      // Город — если просит груз или его принимает получатель (рыбу — рынок).
      const towns = this.towns.filter((t) => t.demands.includes(product) || (this.retail && t.receivers?.some((r) => !r.depot && r.cargo.includes(product))));
      add(product, 'out', [...live.filter((i) => i.info.accepts.includes(product)), ...towns]);
      for (const c of target.info.accepts) add(c, 'in', live.filter((i) => i.info.produces === c));
    } else {
      for (const c of target.demands) add(c, 'in', live.filter((i) => i.info.produces === c));
    }
    return result;
  }

  // ---------- Прочее ----------

  structureAt(p: Vec): Structure | null {
    return this.index.at(p, 2);
  }

  private routeCache = new Map<string, Vec[] | null>();
  private routeCacheVersion = -1;
  /** Линии дорожных маршрутов по участкам (roadLegs): по линии — ключ (версия сети, остановки) и участки. */
  private legCache = new Map<number, { key: string; routes: (number[] | null)[]; legs: (Vec[] | null)[] }>();
  /** Графики скорости линий (lineSpeedChart): по линии — ключ (версии сети и рельефа, остановки, модель) и график. */
  private speedChartCache = new Map<number, { key: string; chart: SpeedChart | null }>();

  /**
   * Путь машины между станциями по полосам (с учётом стороны движения) — для отрисовки линий.
   * null — дороги между станциями нет.
   */
  routePolyline(fromId: number, toId: number, fromPlatform: number | null = null, toPlatform: number | null = null, keepRight = false): Vec[] | null {
    const version = this.net.version * 100003 + this.roads.net.version;
    if (this.routeCacheVersion !== version) {
      this.routeCache.clear();
      this.routeCacheVersion = version;
    }
    const key = `${fromId}>${toId}:${fromPlatform ?? ''}>${toPlatform ?? ''}${keepRight ? ':R' : ''}`;
    if (this.routeCache.has(key)) return this.routeCache.get(key)!;
    const from = this.stations.get(fromId);
    const to = this.stations.get(toId);
    if (from?.kind === 'rail' || to?.kind === 'rail') {
      // Ж/д линия — по осям путей между платформами (выбранными для остановок, иначе — боковыми).
      const starts = from && fromPlatform !== null ? [fromPlatform] : from ? sidingsFirst(from).slice(0, Math.max(1, from.platforms.length - 1)) : [];
      const goal = to && toPlatform !== null ? [toPlatform] : (to?.platforms ?? []);
      const rail = from && to && from.kind === to.kind ? this.rail.previewRoute(starts, goal, toPlatform !== null || !to ? undefined : throughOf(to)) : null;
      this.routeCache.set(key, rail);
      return rail;
    }
    const route = from && to ? this.roads.route(from.nodeId, to.nodeId) : null;
    const pts = route ? this.roads.routePolyline(route, keepRight) : null;
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
      // Станция у получателя невидима: по клику — сам магазин (receiverAt).
      if (st.kind === 'dock') continue;
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

  /** Сетка парков для выбора мышью (world/parkPick.ts): пересобирается, только когда у городов сменились парки. */
  private readonly parkIndex = new ParkIndex();

  /**
   * Парк, сквер, площадь или набережная под курсором — для «Выбора». Дорога или путь поверх парка (полотно игрока
   * ложится поверх зелени) — не парк: клик по ним парк не выбирает. Здания, станции и прочее проверяет вызывающий
   * раньше (structureAt) — они главнее.
   */
  parkAt(p: Vec): ParkEntry | null {
    const hit = this.parkIndex.at(this.towns, p);
    if (!hit) return null;
    for (const c of this.roads.net.corridorsNear(p, 40)) {
      const q = c.lut.closest(p);
      if (q.d < halfAtS(c, q.s)) return null;
    }
    for (const s of this.net.segmentsNear(p, 20)) if (s.lut.closest(p).d < halfWidth(s.spec)) return null;
    return hit;
  }

  /** Парк по id (TownPark.id): для карточки и обводки выбранного. */
  parkById(id: number): ParkEntry | null {
    return this.parkIndex.get(this.towns, id);
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
      // Строительный поезд на месте работ рисует стройка — у края работ, а не там, где он в симуляции.
      if (this.construction.trains?.drawnBySite(train.id)) continue;
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
    const to = bayPose(this.bayArea(st), st.bays, Math.min(v.bay ?? 0, st.bays - 1), m.spec.length, gate ? bayFront(st.fp, gate.pos) : 1);
    // По площадке станции — прямо, носом к зданию (между перронами, в бокс): от края площадки до поста.
    const run = st.fp.h / 2 + dot(sub(to.pos, st.fp.center), to.dir);
    return entryPose(v.enter, to, m.spec.length, run);
  }

  /** Машина компании на виду: на дороге — из движения, на заезде — по пути к посту. */
  fleetLook(v: FleetVehicle): VehicleLook | undefined {
    const sim = this.fleetSim(v);
    if (sim) return sim;
    // Во дворе получателя — там, где грузовик на манёвре или у рампы (docks.ts).
    const yard = this.docks.poseOf(v.id);
    if (yard) return this.fleetLookAt(v.id, yard.pos, yard.dir);
    const m = MODELS[v.model];
    const pose = this.bayEntryPose(v);
    if (!pose || m.mode !== 'road') return undefined;
    const color = this.lines.get(v.lineId)?.color ?? m.spec.color;
    return { ...m.spec, color, load: v.cargo ? CARGO[v.cargo].color : undefined, tank: this.isTanker(v), pos: pose.pos, dir: pose.dir };
  }

  /** Машина компании, поставленная в точку pos носом по dir (автобус на посадке у остановки). */
  fleetLookAt(id: number, pos: Vec, dir: Vec): VehicleLook | undefined {
    const v = this.fleet.get(id);
    const m = v && MODELS[v.model];
    if (!v || !m || m.mode !== 'road') return undefined;
    const color = this.lines.get(v.lineId)?.color ?? m.spec.color;
    return { ...m.spec, color, load: v.cargo ? CARGO[v.cargo].color : undefined, tank: this.isTanker(v), pos, dir };
  }

  /**
   * Где машина или поезд компании на карте сейчас — центр и радиус кольца вокруг (обводка выбранной,
   * подсветка из списка маршрута): на дороге и на заезде — по кузову, на посту автостанции и у остановки —
   * там, где её рисуют (и новую, что грузится, не заняв поста, — см. bayLayout), поезд — по середине состава.
   * На посту автостанции ещё и box — сам бокс поста: подсвечивают его, а не кольцо во всю станцию.
   * Самой машины на карте нет (все посты заняты, у остановки, поезд ждёт платформу) — кольцо вокруг станции, с station: true.
   */
  fleetSpot(v: FleetVehicle): { pos: Vec; r: number; station?: boolean; box?: Footprint } | null {
    const train = this.fleetTrain(v);
    const mid = train && this.rail.pointAt(train, train.head - train.length / 2);
    if (train && mid) return { pos: mid.pos, r: train.length / 2 + 8 };
    const m = MODELS[v.model];
    const line = this.lines.get(v.lineId);
    const st = line && this.stations.get(line.stops[v.stop]);
    let look: Pose | undefined = m.mode === 'road' ? this.fleetLook(v) : undefined;
    if (!look && st && m.mode === 'road' && v.state !== 'driving') {
      const gate = this.roads.net.nodes.get(st.nodeId);
      // Пост — тот, что окрашен под эту машину на рисунке станции.
      const bay = st.kind === 'road' ? this.bayLayout(st).indexOf(v.id) : -1;
      const i = st.kind === 'stop' && v.inBay ? st.occupied.indexOf(v.id) : -1;
      if (bay >= 0) {
        const box = bayBox(this.bayArea(st), st.bays, bay, gate ? bayFront(st.fp, gate.pos) : 1);
        return { pos: box.center, r: Math.hypot(box.w, box.h) / 2 + 2, box };
      }
      if (i >= 0) look = this.stopBerthAt(st, i);
    }
    if (look && m.mode === 'road') {
      const L = m.spec.length;
      return { pos: sub(look.pos, scale(look.dir, L / 2)), r: L * 0.9 + 3 };
    }
    // В пути, но не на дороге (потерялась, ждёт выезда) — не показываем; на станции — её саму.
    return st && v.state !== 'driving' ? { pos: st.fp.center, r: footprintRadius(st.fp), station: true } : null;
  }

  /**
   * Место i-го автобуса на посадке у остановки (stopBerth, по st.occupied): своей ширины, носы — через самый длинный
   * из стоящих и зазор IDM.minGap, друг на друга не заходят.
   */
  stopBerthAt(st: Station, i: number): Pose {
    const spec = (id: number | undefined) => {
      const v = id !== undefined ? this.fleet.get(id) : undefined;
      const m = v && MODELS[v.model];
      return m?.mode === 'road' ? m.spec : undefined;
    };
    const longest = Math.max(12, ...st.occupied.map((id) => spec(id)?.length ?? 0));
    const gate = this.roads.net.nodes.get(st.nodeId);
    return stopBerth(st.fp, gate?.pos, i, st.occupied.length, spec(st.occupied[i])?.width, longest + IDM.minGap);
  }

  /**
   * Машины бригад не в потоке (в потоке их рисует сама симуляция): колонна, что едет вдоль стройки по оси проекта, и
   * доехавшие по дороге машины, что ждут на месте остальных (Crews.carsAt).
   */
  /**
   * База бригады, чья машина не в потоке (вдоль стройки, ждёт колонну) под точкой p: клик по ней открывает карточку
   * базы со всеми её бригадами и что они делают (машины в потоке узнаются по симуляции — crewOfSim). Нет — undefined.
   */
  crewBaseAt(p: Vec, r = 6): number | undefined {
    const crews = this.construction.crews;
    for (const b of crews.brigades.values()) {
      for (const m of crews.carsAt(b)) {
        const s = CREW_CARS[Math.min(m.car, CREW_CARS.length - 1)];
        // Точка машины — нос: середина кузова — на полдлины позади.
        const mid = sub(m.pos, scale(m.dir, s.length / 2));
        if (dist(mid, p) <= s.length / 2 + r) return b.base;
      }
    }
    return undefined;
  }

  /**
   * Машины бригад не в потоке (в потоке их рисует сама симуляция) — те же машины тем же рисунком (crewLane.CREW_UNITS):
   * на стройке — по полосе бригады (едут на свои места в колонне этапов и работают у краёв этапов), вдоль стройки к
   * дороге, ждут выезда в поток (Crews.carsAt). Вторая часть (самосвал за грейдером, каток за укладчиком) — по следу
   * передней на полосе; на мосту — на высоте настила. stage — этап машины; site — участок, если машина на нём (там
   * отсыпку моста и тоннеля ведут кран и щит); маячок мигает, пока машина работает у своего края.
   */
  siteCrewLooks(): CrewLook[] {
    const out: CrewLook[] = [];
    const crews = this.construction.crews;
    const net = this.roads.net;
    const blink = this.speed > 0 && Math.floor(this.time * 3) % 2 === 0;
    for (const b of crews.brigades.values()) {
      const cars = crews.carsAt(b);
      if (!cars.length) continue;
      const p = b.project !== undefined ? this.construction.projects.get(b.project) : undefined;
      const front = b.lane && b.project !== undefined ? this.construction.frontFor(b.project, b) : null;
      const c = front?.c ?? null;
      const fromB = !!front?.fromB;
      const leg = c?.build ? b.lane?.legs.find((g) => g.corridor === c.id && g.fromB === fromB) : undefined;
      const spans = c?.build ? spansOf(c.build, c.length) : null;
      const going = !!p && !p.paused && p.stalled === undefined && b.state === 'working';
      // Ж/д проект: участок — путь (сеть путей), техника — по земле, без крана и щита (у дороги — site).
      const rail = !!p?.rail;
      const raised = !rail && !!c && Math.max(net.node(c.a).level, net.node(c.b).level) > 0;
      for (const m of cars) {
        const spec = this.crewCar(b, m.car);
        const h = hitchOf(spec.body);
        const u = leg && m.s !== undefined ? m.s - leg.at : null;
        const site = !!c && u !== null && u >= -0.5 && u <= c.length + 0.5;
        // Точка машины — её нос (кузов тянется назад, как у машин в потоке); вторая часть — по следу на полосе.
        let pos = m.pos;
        let trail = h && b.lane && m.s !== undefined ? laneTrail(b.lane, m.s, m.pos, m.dir, h.joint * spec.length, h.tail * spec.length, m.car) : undefined;
        if (site && raised) {
          const lift = bridgeLook(deckAlong(net, c as Corridor, fromB ? c!.length - u! : u!)).lift;
          pos = add(pos, lift);
          if (trail) trail = add(trail, lift);
        }
        const f = spans?.[m.car] ?? 0;
        const active = site && f > 0 && f < c!.length - 1e-6 && Math.abs(u! - f) < 1;
        out.push({
          kind: spec.kind,
          body: spec.body,
          length: spec.length,
          width: spec.width,
          color: spec.color,
          pos,
          dir: m.dir,
          ...(trail ? { trail } : {}),
          beacon: active && going && blink,
          stage: m.car,
          ...(site && !rail ? { site: c!.id } : {}),
        });
      }
    }
    return out;
  }

  /** Машины, что сейчас заезжают на посты автостанций, и грузовики во дворах получателей (на манёвре и у рампы). */
  enteringLooks(): VehicleLook[] {
    const out: VehicleLook[] = [];
    for (const v of this.fleet.values()) {
      const look = v.enter && this.fleetLook(v);
      if (look) out.push(look);
    }
    for (const id of this.docks.yardIds()) {
      const pose = this.docks.poseOf(id);
      const look = pose && this.fleetLookAt(id, pose.pos, pose.dir);
      if (look) out.push(look);
    }
    return out;
  }

  /** Посты автостанции по порядку: цвет линии машины, что там стоит (или заезжает), или null — пусто. */
  stationBays(st: Station): (string | null)[] {
    return this.bayLayout(st).map((id) => {
      if (id === null) return null;
      const v = this.fleet.get(id);
      return (v && this.lines.get(v.lineId)?.color) ?? '#e07b39';
    });
  }

  /**
   * Машины на постах автостанции — сами, как их рисовать (у автовокзала автобус виден между перронами): на своём посту
   * (том, что окрашен под неё, — bayLayout) носом к зданию, а та, что ещё заезжает, — там, где она на заезде.
   */
  bayLooks(st: Station): VehicleLook[] {
    // У автовокзала у края улицы автобусы стоят на самой улице — их рисует движение.
    if (st.kind !== 'road' || st.curb) return [];
    const gate = this.roads.net.nodes.get(st.nodeId);
    const front = gate ? bayFront(st.fp, gate.pos) : 1;
    const area = this.bayArea(st);
    const out: VehicleLook[] = [];
    this.bayLayout(st).forEach((id, bay) => {
      const v = id !== null ? this.fleet.get(id) : undefined;
      const m = v && MODELS[v.model];
      if (!v || !m || m.mode !== 'road') return;
      const pose = v.enter ? null : bayPose(area, st.bays, bay, m.spec.length, front);
      const look = pose ? this.fleetLookAt(v.id, pose.pos, pose.dir) : this.fleetLook(v);
      if (look) out.push(look);
    });
    return out;
  }

  /**
   * Кто на каком посту автостанции нарисован (id машины или null — пусто). Сперва машины на своих постах; без своего
   * (старое сохранение, постов убавили) — на первый свободный; за ними — машины, что грузятся здесь, не заняв поста
   * (новые ждут на первой станции, не мешая подъезжающим), — на оставшиеся свободные: погрузку видно на посту.
   */
  private bayLayout(st: Station): (number | null)[] {
    const out: (number | null)[] = Array.from({ length: st.bays }, () => null);
    if (st.curb) {
      // У края улицы — по порядку от переднего места: кто встал или встаёт к перрону.
      const occ = this.curbOccupants(st).sort((a, b) => b.front - a.front);
      occ.slice(0, st.bays).forEach((o, i) => (out[i] = o.id));
      return out;
    }
    const rest: number[] = [];
    for (const id of st.occupied) {
      const bay = this.fleet.get(id)?.bay;
      if (bay !== undefined && bay < st.bays && out[bay] === null) out[bay] = id;
      else rest.push(id);
    }
    for (const id of [...rest, ...this.waitingOffBay(st)]) {
      const i = out.indexOf(null);
      if (i < 0) break;
      out[i] = id;
    }
    return out;
  }

  /** Машины компании, что стоят на этой автостанции, не заняв поста: грузятся, ждут интервала или выезда. */
  private waitingOffBay(st: Station): number[] {
    if (st.kind !== 'road') return [];
    const out: number[] = [];
    for (const v of this.fleet.values()) {
      if (v.inBay || v.simId !== null || v.state === 'driving' || MODELS[v.model].mode !== 'road') continue;
      if (this.lines.get(v.lineId)?.stops[v.stop] === st.id) out.push(v.id);
    }
    return out;
  }

  isFleet(sim: Vehicle): boolean {
    return this.owners.get(sim.id)?.type === 'fleet';
  }

  /**
   * Всплывающее уведомление. С видом (info.kind) — ещё и запись в истории «События»: так отмечены события партии,
   * а подсказки на действия игрока («Не хватает денег») — без вида и в историю не идут.
   */
  notify(text: string, color?: string, info: NoticeInfo = {}): void {
    const { kind, refs, at, recipe } = info;
    const entry = kind ? this.news.add(this.month, { kind, text, color, refs, at, recipe }) : undefined;
    // То же уведомление ещё на экране (на паузе оно не гаснет, а «Не хватает денег» можно получить десять раз
    // подряд) — не второе такое же, а прежнее заново, внизу.
    const same = this.notices.findIndex((n) => n.text === text);
    if (same >= 0) this.notices.splice(same, 1);
    this.notices.push({
      id: ++this.noticeSeq,
      text,
      color,
      age: 0,
      ...(entry ? { news: entry.n } : {}),
      ...(at ? { at } : {}),
      ...(refs?.length ? { refs } : {}),
      ...(recipe ? { recipe } : {}),
    });
    this.journal.add('note', { text });
  }

  /**
   * Время уведомлений (реальное, от скорости игры не зависит): идёт игра — стареют и через NOTICE_LIFE уходят;
   * пауза — не стареют и горят в полную силу (уже гаснувшее — тоже), пока игру не продолжат или их не закроют.
   */
  private ageNotices(realDt: number): void {
    const paused = this.speed === 0;
    for (const n of this.notices) n.age = paused ? Math.min(n.age, NOTICE_LIFE - NOTICE_AFTER_PAUSE) : n.age + realDt;
    for (let i = this.notices.length - 1; i >= 0; i--) if (this.notices[i].age > NOTICE_LIFE) this.notices.splice(i, 1);
  }

  /** Крестик на уведомлении: убрать с экрана (запись в истории «События» остаётся). */
  closeNotice(id: number): void {
    const i = this.notices.findIndex((n) => n.id === id);
    if (i >= 0) this.notices.splice(i, 1);
  }

  /** Клик по уведомлению: его запись в истории — прочитана, на колокольчике её больше нет. */
  readNotice(id: number): void {
    const n = this.notices.find((x) => x.id === id);
    if (n?.news !== undefined) this.news.read(n.news);
  }

  inFootprint(p: Vec, fp: Footprint): boolean {
    return pointInFootprint(p, fp);
  }
}

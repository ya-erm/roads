import { GRADE, STATION } from '../config';
import { Cubic, CurveLUT } from '../core/bezier';
import { clamp, hash } from '../core/math';
import { drawWalkSign } from './walkSign';
import { add, cubicBezier, dist, dot, rightNormal, scale, sub, Vec } from '../core/vec';
import type { Plan, Snap } from '../game/build';
import { FOOTPATH, pathFootprint, type Footpath } from '../game/footpaths';
import { stationNormal } from '../game/railStationEdit';
import { additionalStationGates, stationRoadFront } from '../game/stationAccess';
import { warningMarks } from '../game/stationWarnings';
import { paxGone } from '../game/paxPatience';
import { headingArrow } from '../game/stopPairs';
import type { Spans } from '../game/constructionWork';
import type { Game, LaneEnd, Partner } from '../game/game';
import { bayFront, baySlot, industryApronEnd, LONGEST_BUS, openBayEnd, openBayRear, type FleetVehicle, type Line } from '../game/transport';
import { bridgeLook, deckAlong } from '../lanes/deck';
import { atPortals, type Portal, portalHalf, tunnelPortals } from '../lanes/tunnel';
import { LaneRenderer, layerOf } from '../lanes/draw';
import { insideRuns } from '../lanes/edit';
import { asphaltEdgesAt, edgesAt, laneBand, pointOff, stations as axisStations } from '../lanes/geometry';
import { type Corridor, type CorridorEnd, corridorMargin, type LaneNet, type LaneNode } from '../lanes/model';
import type { GMove, LaneGraph } from '../lanes/graph';
import type { TurnLook, TurnState } from '../lanes/lights';
import { type LightSpot, lightSpot } from '../lanes/lightSpot';
import { type JunctionPreview, junctionPreview, previewHides } from '../lanes/preview';
import { trackKmhExact } from '../sim/railSpeed';
import type { Vehicle, VehicleLook } from '../sim/vehicle';
import { trainWagonFills } from '../sim/wagons';
import { cargoImage, walkImage } from '../ui/cargoIcons';
import { BIOMES } from '../world/biomes';
import { CARGO, CargoType, FREIGHT, INDUSTRY_TYPES, type IndustryKind } from '../world/cargo';
import { Annex, Industry, isBusTerminal, Station, Town, TownBuilding, TownPark } from '../world/entities';
import type { IndustryPlan } from '../game/enterprises';
import {
  depositBox,
  depositRadius,
  depositSig,
  dirtyIndustries,
  drawDeposit,
  drawHarmZone,
  drawRuinOverlay,
  drawSiteArt,
  drawSiteCrane,
  drawSoot,
  enterpriseReach,
  enterpriseSig,
  houseGrime,
} from './enterpriseArt';
import { townEdge, townIndustries, townSlots } from '../world/enterprise';
import { sizeDots, sizeDotsVisibility } from '../ui/enterpriseUi';
import { lastTownNeed } from '../world/townSupply';
import { roomFor, stockedCount, stockFill } from '../world/retail';
import { goalShops } from '../scenario/objectives';
import { lotFrame } from '../world/houseAccess';
import { roofCenter } from '../world/shopLots';
import type { Segment } from '../world/network';
import { halfWidth, isDirt, KMH_PER_UNIT, LANE_W, RAIL_HALF, ROAD_ASPHALT, ROAD_MARGIN, roadEdges } from '../world/roadTypes';
import { Footprint, footprintCorners, footprintRadius } from '../world/spatial';
import { prefOn } from '../ui/prefs';
import { annexMotion, drawAnnexArt } from './annexArt';
import { Camera } from './camera';
import type { Motion } from './redraw';
import { artMoves, type ArtLayer, drawEmitters, drawIndustryArt, type Emitter, industryMotion } from './industryArt';
import { paintIndustrySite, tracePlot } from './industrySite';
import { drawIndustrialGate, drawIndustrialRoads, industryRoadSurface } from './industryRoadArt';
import { drawIndustryHaulConnection, drawIndustryTransfer, drawIndustryYard, drawIndustryYardStock } from './industryStationArt';
import { drawHouseArt, FINE_ZOOM, hallFountain, houseReach } from './houseArt';
import { alleyScope, drawFountainRipples, drawParkArt, drawStreetGreen, FOUNTAIN_ZOOM, PARK_REACH, parkFountains, streetGreen, type StreetGreen } from './parkArt';
import { type Around, gameSidewalks, mergeSidewalks, type SidewalkCache, type SidewalkNet, sidewalkNet, sidewalkScope, type WalkSite, walkSite } from './sidewalks';
import { iconRaster } from './iconRaster';
import { EarthworkCache } from './earthworks';
import { altitudeText, contourLabel, fineContourStep, gradeRungs, heightLabel, ReliefRenderer, waterPath } from './relief';
import { type Box, grow, GROUND, SceneDiff, STATIONS, type Tile, TILE_CANVAS, TILE_PAD, TILE_PX, tileBox, TileCache, tileRect, type TileSet, UNDER, unite } from './tileCache';
import { drawTurnArrows } from './turnArrows';
import { baseBox, baseSig, buildingCorridors, drawBases, drawClosures, drawOldRoad, drawMachines, drawParked, drawProjectShadows, drawProjects, drawnSpans, nodeReach, nodeStage, progressBoxes, projectBox, projectJoints, projectNodes, projectSig } from './constructionArt';
import { projectBadges } from './projectBadges';
import { drawRailProjects, drawTrackMachines, railProjectSig } from './railProjectArt';
import { WORK_TRAIN } from '../game/workTrains';
import { SERVICES } from '../game/services';
import { drawInSight, drawPortalGear, drawWorkLights, entryPortal, siteKind, tunnelSight } from './structureArt';
import { corridorHalf, curbGap } from '../world/worldgen';
import { storeysOf } from '../world/townForms';
import { drawDriveMouths, drawTownWalks, driveClearance, type TownWalks, townWalks } from './townWalks';
import { openNet } from '../lanes/open';
import { TOOLTIP_MAX_PX, tooltipOffset, wrapLines } from './tooltipLayout';
import { drawVehicleArt, flashSpot, type Frame, frontLength, resetFrame, setFrame, sirenVisibility, type VehicleDrawOptions } from './vehicleArt';
import { drawTrafficLight, type Lamp, lampOf, type LightLook, lightScale } from './trafficLightArt';
import { curveZones, PROFILE_STEP } from '../lanes/speedProfile';
import { type Hiders, polygonHiders, TreeCover } from './treeCover';
import { junctionPlate } from '../world/lotClear';
import { carLayers, railSegLayer } from './trainLayer';
import { corridorLayer, deckLift, deckLine, inPass, signSpot, speedStrokes, strokePoint } from '../lanes/speedDisplay';
import { BUY_DOT_PX } from '../input/buyDrop';
import { parkingLevel, type ParkingCell, type ParkingLevel } from '../game/parkingLayer';
import { drawLotArt, drawLotPreview } from './lotArt';
import type { LotGate } from '../world/entities';
import type { LotRect } from '../world/houseAccess';

/** Площадка-стоянка рисуется за свой участок на столько ед.: заезд через тротуар к воротам. */
const LOT_REACH = 8;

/**
 * Площадка-стоянка в предпросмотре (инструмент «🅿️ Площадка», перенос, ручки) или выбранная: участок, ворота (bad —
 * что не встали), места; old — прежнее место (перенос); ручки углов и поворота.
 */
export interface LotOverlay {
  fp: Footprint;
  gates: readonly LotGate[];
  ok: boolean;
  bad?: readonly number[];
  stalls: readonly LotRect[];
  old?: Footprint;
  handles: { pos: Vec; kind: 'corner' | 'rotate' }[];
  selected?: boolean;
}

/** Дорожки кварталов города в его записи кэша карты — под этим номером (id домов и парков — другие). */
const WALKS_KEY = -1e9;

export type Selection =
  | { type: 'station'; id: number }
  | { type: 'industry'; id: number }
  /** Свободное месторождение (режим «Строит игрок»): карточка — что за сырьё, размер, что на нём строить и куда везти. */
  | { type: 'deposit'; id: number }
  | { type: 'town'; id: number }
  | { type: 'building'; id: number }
  /** Парк, сквер, площадь у ратуши, сквер с памятником или набережная города (Town.parks) — по TownPark.id. */
  | { type: 'park'; id: number }
  /** Площадка-стоянка (Town.lots, docs/PARKING.md, этап 3) — по ParkingLot.id. */
  | { type: 'lot'; id: number }
  /** Машина жителя — по её id в симуляции. */
  | { type: 'vehicle'; simId: number }
  | { type: 'parkedCar'; id: string }
  /** Машина или поезд компании: выбор сохраняется на остановках и после отправления. */
  | { type: 'fleet'; id: number }
  /** Перекрёсток: светофор, главная дорога, запреты поворотов. */
  | { type: 'junction'; id: number }
  /** Проект стройки (режим «Со строительством»): карточка — сроки, деньги, бригады, резерв и приоритет. */
  | { type: 'project'; id: number }
  /** Строительная база: карточка — название, бригады и что они делают, нанять и распустить, ближние стройки. */
  | { type: 'base'; id: number }
  /** Строительная бригада: подсвечены все машины колонны; карточка — что делает, «🎯 На стройку…», «↺ Авто». */
  | { type: 'crew'; id: number }
  /** Строительный поезд ж/д проекта (workTrains.ts): маршрут по путям до цели — на карте; карточка — куда, откуда. */
  | { type: 'workTrain'; id: number };

export interface ToolOverlay {
  footpath?: { a: Vec; b: Vec; ok: boolean };
  vehicleGhost?: { look: VehicleLook; ok: boolean };
  parkingTargets?: { pos: Vec; dir: Vec; free: boolean }[];
  parkingPreview?: { pts: Vec[]; goal: Vec; dir: Vec; ok: boolean };
  /** Выбираем стройку для бригады («🎯 На стройку…»): проект под курсором — подсвечен, как выбранный. */
  crewTarget?: number | null;
  hover: Vec | null;
  snap: Snap | null;
  chainStart: Snap | null;
  control: Vec | null;
  plan: Plan | null;
  /** Ещё дороги в предпросмотре — например, все дороги переносимого узла. */
  plans?: Plan[];
  /** Подсвеченный участок не сносим, а правим — синим. */
  highlightEdit?: boolean;
  /** Перья участка в режиме «Двигать»: концы, управляющие точки и какая из них в руке. */
  /** Перья: от конца участка (anchor) к управляющей точке (pos); partner — перо продолжающей дороги. */
  handles?: { anchor: Vec; pos: Vec; active: boolean; partner: boolean }[] | null;
  highlightSeg: number | null;
  highlightNode: { pos: Vec; ok: boolean; radius: number } | null;
  station: { fp: Footprint; ok: boolean; haulRoad?: readonly Vec[] } | null;
  /** Остановка встанет парой к той, что напротив (Game.pairPreview): навесы обеих и куда у каждой едут автобусы. */
  stopPair?: { fp: Footprint; dir: Vec }[] | null;
  catchmentAt: Vec | null;
  /** Радиус охвата: у вокзала больше. */
  catchmentR: number;
  /** Магазины будущей станции: связи и подсветка до размещения или переноса. */
  receiverPreview?: { at: Vec; receivers: ReturnType<Game['stationReceivers']> };
  /** Связи грузополучателя с существующими станциями после переноса. */
  receiverMovePreview?: { receiver: ReturnType<Game['stationReceivers']>[number]; stations: Station[] };
  /** Обгонный путь будущего вокзала. */
  railPreview: Cubic[] | null;
  /** Будущий ж/д сигнал: где и для какого направления (или какой снимем). */
  signal: { pos: Vec; dir: Vec; remove: boolean; oneWay?: boolean } | null;
  /** Будущая развязка по шаблону. */
  template: { curves: Cubic[]; ok: boolean } | null;
  /** Рамка копирования или вставки (углы по порядку): синяя, красная — если вставить нельзя. */
  frame?: { pts: Vec[]; ok: boolean } | null;
  lineStops: number[];
  selectedLine: number | null;
  selection: Selection | null;
  /** Предприятия, подсвеченные из панели цепочек. */
  highlight: number[];
  /** Груз, выбранный в «Цепочках»: его получатели в городах пульсируют (world/retail.ts). */
  cargoFocus?: CargoType | null;
  /** Место, на которое показали из карточки (пульсирующее кольцо на пару секунд). */
  ping: { pos: Vec; r: number } | null;
  /** Точка маршрута под курсором на графике скорости линии: где она и какая там скорость. */
  chartPoint?: { pos: Vec; color: string; kmh: number } | null;
  /** Машина открытого маршрута под курсором в его списке — пульсирующим кольцом. */
  fleetHover?: number | null;
  /** Рамка сноса и что под неё попадёт. */
  area: { a: Vec; b: Vec; segs: number[]; corridors: number[]; fps: Footprint[] } | null;
  /** Отметки зданий: снос (bad) или место для переноса (ok/bad). */
  marks: { fp: Footprint; ok: boolean; /** Жёлтым: участок ужмётся (полоса стоянки, world/curbSqueeze.ts). */ warn?: boolean }[];
  /**
   * Перенос и поворот ратуши, парка, сквера (Game.movePlan, parkMovePlan): как они встанут — их же рисунком поверх
   * отметки места, с поворотом (нельзя — под красной заливкой).
   */
  ghosts?: { building?: TownBuilding; park?: TownPark; ok: boolean }[] | null;
  /** Ручка поворота ↺ (world/moveTurn.ts): где она, вокруг какой точки, тянут ли её сейчас. */
  turnHandle?: { pos: Vec; pivot: Vec; active: boolean } | null;
  buildingResize?: {
    corners: { pos: Vec; edge: 'front' | 'back'; side: -1 | 1 }[];
    active?: { edge: 'front' | 'back'; side: -1 | 1 };
    preview?: { fp: Footprint; ok: boolean };
    cursor?: string;
  };
  /** Подпись у курсора: ok — тёмная, иначе красный отказ; warn — жёлтая (можно, но с оговоркой: проект дороже денег). */
  label: { text: string; ok: boolean; warn?: boolean } | null;
  heatmap: boolean;
  /** Карта скоростей: цвет дороги — разрешённая скорость, на поворотах — сниженная. */
  speedmap?: boolean;
  /** Слой «🅿️»: занятость мест для машин по клеткам (game/parkingLayer.ts). */
  parkmap?: boolean;
  /** Площадка-стоянка: предпросмотр (ставим, переносим, тянем ручку) или выбранная — её ручки и ворота. */
  lot?: LotOverlay | null;
  /** Карта скоростей в «Выборе»: скорость дороги под курсором — подписью, как высота («90 км/ч», «80 / 90 км/ч»). */
  speedText?: string | null;
  /** Строим дорогу или путь: изолинии ярче, у курсора подпись высоты. */
  roadTool: boolean;
  /**
   * Дорогу не дают построить из-за уклона (подъём, насыпь, выемка): поперёк её превью — «лесенка» изолиний с высотами,
   * ступеньки, где земля круче предела дороги, — красные (drawGradeRungs).
   */
  gradeMarks?: boolean;
  /** На сколько −/+ подняли или опустили конец дороги относительно начала («+14 м») — синим после высоты у курсора. */
  rise?: string | null;
  /** Курсор над мостом: вместо высоты земли — «высота моста 67 м · земля 55 м». */
  heightText?: string | null;
  /** Высота начала строящейся дороги или пути, м — подписью у начала (у курсора — высота конца). */
  startHeight?: { pos: Vec; m: number } | null;
  /** Кисть рельефа: где и какого радиуса (красная — здесь нельзя). */
  brush?: { pos: Vec; r: number; ok: boolean } | null;
  /** Дороги с тем, что сейчас строим или правим: эта сеть рисуется вместо настоящей, изменённое подсвечено. */
  roads?: { net: LaneNet; ok: boolean; changed: number[]; /** Проект: изменённое — синим. */ project?: boolean } | null;
  /**
   * Проект дороги или пути: участки — пунктиром по кромкам (что не выходит — красным; fill — полупрозрачной
   * заливкой, если участок не виден как будущая дорога), узлы — квадратиками (tip — откуда ведём, hot — под курсором).
   */
  project?: {
    segs: { curve: Cubic; half: number; ok: boolean; fill: boolean; draft?: boolean }[];
    nodes: { pos: Vec; tip: boolean; hot: boolean }[];
    /** Знаки скорости перед поворотами (как у построенной дороги): на оси, по ходу, до кромки справа, км/ч. */
    signs?: { pos: Vec; dir: Vec; side: number; kmh: number }[];
    /**
     * Площадки перекрёстков, которые проект меняет (скругление угла, перенос узла): заливкой, бордюры углов —
     * пунктиром, обрезы подъездов (где встанут стоп-линии) — сплошной чертой; что не выходит — красным.
     */
    plates?: { poly: Vec[]; curbs: Vec[][]; cuts: [Vec, Vec][]; ok: boolean }[];
  } | null;
  /** Полотна построенной сети, что в проекте уходят или меняют форму: их знаки на поворотах — бледно (старые). */
  staleSigns?: Set<number> | null;
  /** Тянут дорогу в «Двигать»: знаки этих полотен построенной сети не рисуем — дорога уже в новой форме. */
  hiddenSigns?: Set<number> | null;
  /** …а знаки на её поворотах — по новой форме, прямо во время протяжки (как у построенной). */
  liveSigns?: { pos: Vec; dir: Vec; side: number; kmh: number }[] | null;
  /** Полотно под курсором: снос — красным, правка — синим, перестройка — зелёным. */
  corridor?: { id: number; color: 'red' | 'blue' | 'green' } | null;
  /** Полоса под курсором, которую снесут, — красным. */
  lane?: { corridor: number; lane: number } | null;
  /**
   * Полосы стоянки в предпросмотре «Полосы» с 🅿️ (в сети o.roads): зелёный — всё помещается, жёлтый — участки домов
   * ужмутся, красный — снос или нельзя.
   */
  curbLanes?: { corridor: number; lane: number; color: 'green' | 'yellow' | 'red' }[] | null;
  /** Кружки: начало дороги, куда примкнёт, узел под курсором. */
  /** node — узел, за который тянут («Двигать»): рисуется квадратом узла, а не кружком. */
  points?: { pos: Vec; color: string; r?: number; node?: boolean }[];
  /** Настройка полос выбранного перекрёстка: метки концов полос, выбранный въезд, метка под курсором. */
  laneEdit: { node: number; ends: LaneEnd[]; from: { seg: number; i: number } | null; hover: LaneEnd | null } | null;
  /**
   * Пешеходные переходы выбранного перекрёстка в «Перекрёстке»: значок-переключатель у правого бордюра каждого подъезда,
   * где переход возможен, hover — подъезд под курсором.
   */
  walkEdit?: { node: number; toggles: WalkToggle[]; hover: number | null } | null;
  /**
   * Правка фазы i светофора на карте: проезды перекрёстка цветом по фазе (states — src/lanes/lights.ts, phaseTurnStates),
   * hover — проезд под курсором, flash — отказ дать зелёный (мигают красным). Светофоры перекрёстка — в этой фазе.
   */
  phaseEdit?: { node: number; i: number; states: Map<string, TurnState>; hover: string | null; flash: string[] } | null;
  /** Курсор на варианте главной дороги в карточке перекрёстка: его и показываем (mainPair: null — «Авто», [] — равнозначный). */
  mainHover?: { node: number; mainPair: number[] | null } | null;
  /**
   * Инструмент «Предприятие» (режим «Строит игрок»): какой вид ставим и где он встанет (plan — под курсором): участок,
   * черта городов, кольцо вреда, пунктиры к партнёрам; месторождения этого вида — ярче.
   */
  industry?: { kind: IndustryKind | null; plan: IndustryPlan | null } | null;
  /**
   * Покупку из карточки маршрута тянут на карту: остановки линии — кружками с номерами цвета линии (hot — куда
   * отпустится), пары остановок — пунктиром через улицу (бросок на любую половину); у курсора — значок машины и
   * номер остановки target (мимо — null).
   */
  buyDrop?: {
    color: string;
    kind: 'truck' | 'bus' | 'freight' | 'passenger';
    spots: { at: Vec; n: number; hot: boolean }[];
    pairs: [Vec, Vec][];
    target: number | null;
  } | null;
}

/** Радиус метки полосы: по ширине полосы, но не меньше нескольких пикселей — чтобы попасть и издалека. */
export const laneMarkRadius = (zoom: number) => Math.max(LANE_W * 0.36, 4 / zoom);

/** Значок-переключатель пешеходного перехода в «Перекрёстке». */
export interface WalkToggle {
  corridor: number;
  underground?: boolean;
  /** Центр знака — у бордюра на конце зебры (наполовину на тротуаре): зебра под ним видна. */
  pos: Vec;
  on: boolean;
  own: boolean;
  /** Перехода нет — где была бы зебра: полоски контуром. */
  stripes?: Vec[][];
}

/** Сторона знака перехода: 4,4 м (почти в глубину зебры), но не меньше 18 пикселей — читается и издалека. */
export const walkSignSize = (zoom: number) => Math.max(4.4, 18 / zoom);

/** Цвета карты; трава, деревья и фон вне карты — по биому (BIOMES[…].palette). */
const C = {
  water: '#8cc3e6',
  bank: '#c5e0ee',
  roadEdge: '#4b525c',
  road: ROAD_ASPHALT,
  deck: '#7a828e',
  rail: '#d3d8de',
  shadow: 'rgba(30, 40, 25, 0.25)',
  pillar: 'rgba(70, 76, 84, 0.55)',
  dash: 'rgba(245, 243, 230, 0.85)',
  divider: 'rgba(240, 205, 96, 0.9)',
  island: '#b4cf93',
};

/** Радиус кружка пера на экране, пикселей (и за сколько его можно схватить). */
export const HANDLE_PX = 6;
/** Докуда от перекрёстка подсвечена главная дорога (≈ 45 м: полоса — LANE_W ≈ 3,5 м). */
const MAIN_REACH = 90;
/** Маршрут строительной бригады на карте — оранжевый, как подсветка выбранной стройки и базы. */
const CREW_ROUTE_COLOR = '#f08a3c';

/** Стоп-линия шириной STOP_LINE_W — у самого края перекрёстка: линии полос кончаются ровно на ней. */
const STOP_LINE_W = 1.8;
const STOP_LINE_BACK = STOP_LINE_W / 2;
/** Слева стоп-линия не заходит на осевую (жёлтая — 1.4 шириной по оси). */
const STOP_LINE_INSET = 0.8;
/** Названия остановок — начиная с этого приближения; дальше — только значок. */
const STOP_NAMES_ZOOM = 0.75;
/** Плашки ожидающих у автостанций и вокзалов — начиная с этого приближения (у остановок — всегда). */
const STATION_BADGES_ZOOM = 0.3;
/** Значки получателей грузов над магазинами — вблизи, с этого приближения (выбран их груз — видно и издали). */
const RECEIVER_ZOOM = 0.55;
/** Линии от грузовой станции к получателям в её охвате — с этого приближения. */
const STATION_LINKS_ZOOM = 0.35;
/** Платформы вокзала — не дальше стольких метров от оси своего пути (островные и боковая, с краем). */
const STATION_TRACK_PAD = 15;
/** Тень здания автовокзала. */
const BUS_HALL_SHADOW = 'rgba(30,40,25,0.22)';
/**
 * Над станцией — столбик: внизу плашка ожидающих (её центр — на BADGE_RISE экранных пикселей выше здания),
 * над ней название (плашка 18 пикселей, название — 16,5, между ними зазор ≈ 3).
 */
const BADGE_RISE = 14;
const NAME_RISE = BADGE_RISE + 20;

/** Точка p в рамке view с запасом pad. */
const seenAt = (p: Vec, view: Box, pad: number) => p.x > view.x0 - pad && p.x < view.x1 + pad && p.y > view.y0 - pad && p.y < view.y1 + pad;

/** Верхний край здания на карте — по углам повёрнутого прямоугольника, а не по его высоте. */
function topOf(fp: Footprint): number {
  if (fp.parts) return Math.min(...footprintCorners(fp).map((p) => p.y));
  return fp.center.y - (Math.abs(Math.sin(fp.angle)) * fp.w + Math.abs(Math.cos(fp.angle)) * fp.h) / 2;
}

/** Нижний край здания на карте. */
function bottomOf(fp: Footprint): number {
  if (fp.parts) return Math.max(...footprintCorners(fp).map((p) => p.y));
  return 2 * fp.center.y - topOf(fp);
}

/**
 * Остановка (и автовокзал у края улицы), к которой дорога подходит сверху: её название и плашку — под ней, иначе
 * закроют автобус на посадке.
 */
function labelsBelow(game: Game, st: Station): boolean {
  if (st.kind !== 'stop' && !st.curb) return false;
  const node = game.roads.net.nodes.get(st.nodeId);
  return !!node && node.pos.y < st.fp.center.y;
}

/** Метка транспорта выбранной линии: кружок и значок. */
interface LineMark {
  pos: Vec;
  dir: Vec;
  /** Радиус по настоящему размеру машины. */
  r: number;
  cargo: CargoType | null;
  kind: 'truck' | 'bus' | 'freight' | 'passenger';
  color: string;
  load?: string;
}

interface TrainCar {
  pos: Vec;
  dir: Vec;
  level: number;
  /** Слой отрисовки (−1 тоннель, 0 земля, 1 мост, 2 эстакада) — по участкам под корпусом, см. carLayers. */
  layer: number;
  loco: boolean;
  color: string;
  load?: string;
  /** Насколько заполнен этот вагон, 0..1: груз занимает вагоны по порядку от головы. */
  fill: number;
  kind: 'freight' | 'passenger';
  length: number;
  trainId: number;
}

/** Участок пути, готовый к рисованию. */
interface SegCache {
  /** Ось и ширина насыпи. */
  surface: Vec[];
  width: number;
  /** Высота вдоль поверхности для теней и тоннелей. */
  heights: number[];
  /** Два рельса и концы шпал парами. */
  rail: { rails: Vec[][]; sleepers: Vec[] };
  bbox: { x0: number; y0: number; x1: number; y1: number };
  maxLevel: number;
  minLevel: number;
  wet: boolean;
  rev: number;
}

/** Поворотники мигают с такой частотой (раз в секунду игрового времени). */
const BLINK_HZ = 1.5;
/** Поворотники рисуются, только если машина на экране не уже стольких пикселей. */
const BLINKER_MIN_PX = 3;
/** Мигают ли и задние огоньки поворотника (пока — только передние). */
const BLINK_REAR = false;
/** Мигалка спецмашины: половины меняются столько раз в секунду игрового времени (пара — вдвое реже). */
const SIREN_HZ = 2.5;
/** Ореол горящей половины мигалки — не меньше стольких пикселей экрана: спецмашину видно и издали. */
const SIREN_GLOW_PX = 10;

/** Цвета карты скоростей: до скольких км/ч — каким цветом. */
const SPEED_STEPS: [number, string][] = [
  [20, '#b8322a'],
  [40, '#e8743b'],
  [60, '#efc23c'],
  [80, '#9bc53d'],
  [90, '#3fae5a'],
  [100, '#2a9d8f'],
  [120, '#3b6fd1'],
];
const speedColor = (kmh: number) => (SPEED_STEPS.find(([v]) => kmh <= v + 4) ?? SPEED_STEPS[SPEED_STEPS.length - 1])[1];
/** Толщина линии карты скоростей по оси ж/д пути (мир): чуть шире полосы дороги, но между рельсами. */
const RAIL_SPEEDMAP_W = 3.2;

/** Холст плитки кэша карты (src/render/tileCache.ts). */
interface TileCanvasEl {
  readonly opaque: boolean;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
}

function makeTileCanvas(opaque: boolean): TileCanvasEl {
  const canvas = document.createElement('canvas');
  canvas.width = TILE_CANVAS;
  canvas.height = TILE_CANVAS;
  // Непрозрачный слой (земля) копируется на экран без смешивания — без видеокарты это заметно дешевле.
  const ctx = canvas.getContext('2d', { alpha: !opaque });
  if (!ctx) throw new Error('Canvas 2D недоступен');
  return { opaque, canvas, ctx };
}

/** Что нарисовать неподвижным (на экране или в плитке): партия, оверлей и сеть дорог на карте (с правкой — её копия). */
interface StillScene {
  game: Game;
  o: ToolOverlay;
  /** Дороги, открытые для движения (без строящегося), — их рисует LaneRenderer. */
  roadNet: LaneNet;
  /** Вся сеть с правкой (с проектами стройки) — чертежи стройки по ней. */
  fullNet: LaneNet;
  preview: JunctionPreview | null;
}

/**
 * Плитки в кадре: готовые текущего уровня, где их нет — запасные (растянутые), сдвиг камеры в пикселях холста;
 * live — места устаревших плиток (и дыр без свежего запасного): там неподвижное рисуется прямо в кадре (drawLive).
 */
interface TilePlan {
  set: TileSet<TileCanvasEl>;
  ready: Tile<TileCanvasEl>[];
  missing: Box[];
  fallback: { set: TileSet<TileCanvasEl>; tiles: Tile<TileCanvasEl>[] }[];
  live: Box[];
  scene: StillScene;
  /** Рамка, в которой рисуется вживую (с запасом, как у плитки), и пути в ней. */
  liveView: Box | null;
  liveSegs: Segment[];
  k: number;
  tx: number;
  ty: number;
}

/** На столько вокруг рамки изменения сбрасываются плитки: тени мостов, знаки у кромки, откосы, деревья. */
const DIRTY_PAD = 80;
/** То же для тротуаров на протяжке (их рамка — уже с запасом на ширину): откосы у их концов — в пределах улицы. */
const WALK_PAD = 30;
/** На столько вокруг участка хода работ на строящемся полотне (progressBoxes — уже с запасом на ширину и тень моста). */
const PROGRESS_PAD = 20;
/** Запас вокруг плитки, в котором объекты ещё рисуются в неё (как у края экрана, view()). */
const TILE_MARGIN = 60;
/** Бюджет кадра на перерисовку плиток, мс: устаревших на экране, недорисованных при смене уровня, про запас вокруг. */
const DIRTY_MS = 8;
const FILL_MS = 4;
const AHEAD_MS = 2;

/** Цвет подсветки правки в подписи полотна: по (проект ? 2 : 0) + (можно ? 1 : 0). */
const TINT_KEYS = ['bad', 'ok', 'pbad', 'pok'] as const;

/** Те же ли номера: набор was и next (нет — пусто). */
function sameIds(was: ReadonlySet<number>, next: ReadonlySet<number> | null): boolean {
  if (was.size !== (next?.size ?? 0)) return false;
  for (const id of next ?? []) if (!was.has(id)) return false;
  return true;
}

/** Подпись рамки здания или участка — где и какой формы. */
const fpSig = (fp: Footprint) => `${fp.center.x},${fp.center.y},${fp.w},${fp.h},${fp.angle}`;
/** Рамка контура (повёрнутого прямоугольника) в мире. */
function fpBox(fp: Footprint): Box {
  const r = footprintRadius(fp);
  return { x0: fp.center.x - r, y0: fp.center.y - r, x1: fp.center.x + r, y1: fp.center.y + r };
}

/** Предприятие для кэша карты: уровень, работает ли (дым, огонь), запасы (кучи растут с шагом 5) и пристройки. */
function industrySig(ind: Industry): string {
  let stock = '';
  for (const k in ind.stock) stock += `${k}${Math.floor((ind.stock[k as CargoType] ?? 0) / 5)},`;
  const annexes = (ind.annexes ?? []).map((a) => `${a.id}@${fpSig(a.fp)}`).join(';');
  return `${fpSig(ind.fp)}|${ind.level ?? 1}|${ind.producedMonth > 0 || ind.producedLast > 0 ? 1 : 0}|${stock}|${annexes}`;
}

export class Renderer {
  /** Куда рисуем: экран, а при отрисовке плитки кэша — её холст. */
  private ctx: CanvasRenderingContext2D;
  private cache = new Map<number, SegCache>();
  private cacheVersion = -1;
  private treeVersion = '';
  /** Какие деревья спрятаны — пересчёт только там, где правка (сетка деревьев — одна на карту). */
  private treeCover = new TreeCover();
  /** Кружки пути, прячущие деревья, — по его кэшу отрисовки. */
  private treeRails = new WeakMap<SegCache, number[]>();
  /** Кружки строений, прячущие деревья, — по строению (и его месту и размеру). */
  private treeItems = new WeakMap<object, { pts: number[]; w: number; h: number }>();
  /** Где полотно прячет деревья: кружки x, y, r вдоль оси — пока у полотна та же форма и высоты концов. */
  private treeCuts = new Map<number, { key: string; pts: number[] }>();
  /**
   * Где площадка перекрёстка со скруглёнными игроком углами прячет деревья (дуга бордюра срезает угол квартала далеко
   * от полотен): кружки сеткой — пока те же скругления и формы его полотен.
   */
  private treePlates = new Map<number, { key: string; pts: number[] }>();
  /** Горят ли поворотники в этом кадре: мигают по игровому времени, на паузе — горят ровно. */
  private blinkOn = false;
  /** Какая половина мигалок спецмашин горит в этом кадре (по игровому времени). */
  private flash: -1 | 1 = 1;
  /** Полотна, чьи знаки на поворотах в этом кадре не рисуем (их тянут в «Двигать»), — из оверлея. */
  private hiddenSigns: Set<number> | null = null;
  /** По чьей воде отрисовка дорог считает мосты над рекой. */
  private waterOf: unknown = null;
  /** Порталы тоннелей сети дорог — пересчитываются, когда сеть меняется. */
  private portalCache: { net: LaneNet; version: number; list: Portal[] } | null = null;
  /** Предпросмотр правки дорог: перекрёстки, что она меняет, и граф вокруг них — на версию сети с правкой. */
  private previewOf: { net: LaneNet; version: number; base: LaneNet; baseVersion: number; preview: JunctionPreview | null } | null = null;
  /** Где светофоры въездов (по связи въезда) — для графа движения, пока он тот же. */
  private lightSpots: { graph: LaneGraph; spots: Map<number, LightSpot | null> } | null = null;
  /** Дороги из полос. */
  private readonly lanes = new LaneRenderer();
  /**
   * Проекты стройки — будущие дороги (src/render/constructionArt.ts): свой кэш геометрии только по строящимся полотнам
   * всей сети (fullNet) и их узлам; достроенное или отменённое из него уходит.
   */
  private readonly projectLanes = new LaneRenderer((c) => !!c.build);
  /** Порталы тоннелей в проектах стройки — по версии сети. */
  private projectPortalCache: { net: LaneNet; version: number; list: Portal[] } | null = null;
  /** Отмывка склонов и изолинии — кэш тайлами. */
  private readonly relief = new ReliefRenderer();
  /** Откосы насыпей и выемок у полотен на земле. */
  private readonly earthworks = new EarthworkCache();
  /** Кэш неподвижного плитками (src/render/tileCache.ts); выключатель — Меню → Настройки → «Кэш карты». */
  private readonly tiles = new TileCache<TileCanvasEl>(makeTileCanvas);
  /** Слепки нарисованного в плитках: что поменялось — те плитки и сбросить. */
  private readonly diffs = {
    footpaths: new SceneDiff(),
    corridors: new SceneDiff(),
    nodes: new SceneDiff(),
    rails: new SceneDiff(),
    /** Строящиеся пути ж/д проектов: чертёж и готовое по этапам (railProjectSig). */
    railProjects: new SceneDiff(),
    industries: new SceneDiff(),
    haulRoads: new SceneDiff(),
    /** Месторождения (режим «Строит игрок»): занятое не рисуется — его предприятие на месте. */
    deposits: new SceneDiff(),
    aprons: new SceneDiff(),
    /** Неподвижное станций (слой STATIONS): здания, платформы, склады, выбранные — по stationSig. */
    stations: new SceneDiff(),
    projects: new SceneDiff(),
    /** Будущие дороги проектов: полотна и узлы по отпечатку их геометрии (`c12`, `n7`). */
    projectItems: new SceneDiff<string>(),
    bases: new SceneDiff(),
    towns: new Map<number, { list: TownBuilding[] | null; n: number; parks: TownPark[] | null; np: number; lots: unknown; roads: string; diff: SceneDiff }>(),
    /** Аллеи и фонари вдоль улиц городов (parkArt.streetGreen) — по полотну. */
    alleys: new SceneDiff(),
    /** Тротуары (render/sidewalks.ts): по полотну (`c<id>`) и скругления у узла (`n<id>`). */
    sidewalks: new SceneDiff<string>(),
  };
  /** Аллеи и тротуары: с какими дорогами, строениями, радиусами и застройкой городов посчитаны. */
  private alleys = Renderer.noAlleys();
  /**
   * Аллеи: lines — по сети игры, shown — что на карте (с правкой в предпросмотре — по сети с правкой, liveAlleys), towns —
   * черта городов, по которой посчитаны; live — на какую сеть с правкой, её версию и аллеи без правки посчитаны shown.
   * С чем посчитаны: версия сети, число станций, предприятий и баз, раскладка застройки (layoutRev); черта и число домов
   * городов (townKey: по паре чисел на город) — сверяется, только когда сменился Game.townRev.
   */
  private static noAlleys() {
    return {
      net: -1,
      stations: -1,
      industries: -1,
      bases: -1,
      layout: -1,
      townRev: -1,
      townKey: [] as number[],
      lines: [] as StreetGreen[],
      shown: [] as StreetGreen[],
      towns: [] as { center: Vec; radius: number }[],
      live: null as { net: LaneNet; version: number; base: StreetGreen[] } | null,
      cache: new Map<number, { sig: string; line: StreetGreen | null }>(),
    };
  }
  /** Тротуары городов и их кэш по полотнам (пересчёт — вместе с аллеями). */
  private sidewalks: SidewalkNet = { lines: [], ends: [], spans: new Map() };
  /** Тротуары по сети игры (без правки в предпросмотре); sidewalks — что на карте: с правкой — поверх них. */
  private walkBase: SidewalkNet = this.sidewalks;
  /** Тротуары сети с правкой (liveSidewalks): на какую сеть, её версию и тротуары без правки посчитаны. */
  private walkLive: { net: LaneNet; version: number; base: SidewalkNet; shown: SidewalkNet } | null = null;
  /** Где тротуары для протяжки (liveSite): строения вокруг полотен — запомненные, пока тротуары без правки те же. */
  private walkSite: { game: Game; base: SidewalkNet; memo: Map<string, Around>; site: WalkSite } | null = null;
  private sidewalkCache: SidewalkCache = new Map();
  /** Раскладка застройки (Game.layoutRev), по которой посчитан кэш тротуаров: перенесли дом или парк — кэш прочь. */
  private layoutSeen = 0;
  /** Дорожки кварталов по городам (townWalks): считаются, когда меняется список домов или парков города. */
  private walks = new Map<number, TownWalks>();
  private drivewayOccupied = driveClearance(this.walks.values());
  /** Ход работ на строящихся полотнах в плитках (drawnSpans) — при той же форме (projectSig): шаг сбрасывает только край работ. */
  private progress = new Map<number, { sig: string; spans: Spans }>();
  /** С чем сверены слепки: партия, карта, вид, сеть дорог на карте и её подсветка, номера правок (Game.*Rev). */
  private still = Renderer.noStill();

  private static noStill() {
    return {
      game: null as Game | null,
      footpaths: null as Footpath[] | null,
      terrain: null as unknown,
      /** Вид: биом, изолинии (дорожный инструмент на рельефе), карта скоростей, разметка перекрёстков. */
      biome: '' as string,
      relief: false,
      speedmap: false,
      junctionMarks: false,
      net: null as LaneNet | null,
      version: -1,
      /** Подсветка правки (o.roads.changed — ссылкой и набором), её цвет, бледные и спрятанные знаки (наборами). */
      changedSrc: null as readonly number[] | null,
      tint: new Set<number>(),
      tintColor: '',
      staleSrc: null as ReadonlySet<number> | null,
      stale: new Set<number>(),
      hiddenSrc: null as ReadonlySet<number> | null,
      hidden: new Set<number>(),
      rails: -1,
      /** Вся сеть с проектами стройки и её версия — по ним геометрия будущих дорог. */
      full: null as LaneNet | null,
      fullVersion: -1,
      /** Стройка (Construction.stamp), предприятия, застройка, площадки, станции — номера правок, с которыми сверены. */
      stamp: -1,
      projectsFull: null as LaneNet | null,
      projectsVersion: -1,
      railsStamp: -1,
      railsVersion: -1,
      industries: -1,
      towns: -1,
      lots: -1,
      layout: -1,
      townRoads: null as LaneNet | null,
      townRoadVersion: -1,
      stations: -1,
      /** Неподвижное станций: с какими правками станций, дорог и путей и с каким выбором сверено. */
      stationsStill: -1,
      stationRoads: -1,
      stationRails: -1,
      picked: null as number | null,
      lineStopsSrc: null as readonly number[] | null,
      lineStops: [] as number[],
    };
  }
  /**
   * В последнем кадре было то, что меняется само (пульсация подсветки, всплывающие суммы, значки ещё грузятся) или
   * плитки кэша не дорисованы: следующий кадр нужен, даже если ничего не трогали (src/render/redraw.ts).
   */
  private moving = true;
  /** В последнем кадре двигался фон — дым, огонь, качалки предприятий, огни закрытого переезда: кадры нужны, но реже. */
  private ambient = false;

  /** Что в кадре движется само (src/render/redraw.ts): живое — кадр нужен скоро, только фон — можно реже. */
  get motion(): Motion {
    return this.moving ? 'live' : this.ambient ? 'ambient' : 'none';
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly camera: Camera,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D недоступен');
    this.ctx = ctx;
  }

  /** Сбрасывает кэши геометрии и деревьев (например, для новой игры). */
  reset(): void {
    this.cache.clear();
    this.cacheVersion = -1;
    this.treeVersion = '';
    this.treeCover = new TreeCover();
    this.treeCuts.clear();
    this.treePlates.clear();
    this.lanes.reset();
    this.projectLanes.reset();
    this.projectPortalCache = null;
    this.relief.reset();
    this.earthworks.reset();
    this.forgetStill();
  }

  /** Плитки кэша и слепки нарисованного в них — заново. */
  private forgetStill(): void {
    this.tiles.clear();
    for (const d of [
      this.diffs.corridors,
      this.diffs.footpaths,
      this.diffs.nodes,
      this.diffs.rails,
      this.diffs.railProjects,
      this.diffs.industries,
      this.diffs.haulRoads,
      this.diffs.deposits,
      this.diffs.aprons,
      this.diffs.stations,
      this.diffs.projects,
      this.diffs.bases,
    ])
      d.clear();
    this.diffs.projectItems.clear();
    this.diffs.towns.clear();
    this.diffs.alleys.clear();
    this.diffs.sidewalks.clear();
    this.alleys = Renderer.noAlleys();
    this.sidewalks = this.walkBase = { lines: [], ends: [], spans: new Map() };
    this.walkLive = null;
    this.walkSite = null;
    this.sidewalkCache.clear();
    this.walks.clear();
    this.drivewayOccupied = driveClearance(this.walks.values());
    this.progress.clear();
    this.still = Renderer.noStill();
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.camera.width = w;
    this.camera.height = h;
    this.camera.dpr = dpr;
  }

  private view() {
    const a = this.camera.toWorld(0, 0);
    const b = this.camera.toWorld(this.camera.width, this.camera.height);
    return { x0: a.x - 60, y0: a.y - 60, x1: b.x + 60, y1: b.y + 60 };
  }

  private visible(bb: { x0: number; y0: number; x1: number; y1: number }, v = this.view()): boolean {
    return !(bb.x1 < v.x0 || bb.x0 > v.x1 || bb.y1 < v.y0 || bb.y0 > v.y1);
  }

  /**
   * Кадр. Неподвижное (земля, дороги, дома, мосты) — слоями по высоте: с кэшем карты (Меню → Настройки) они
   * копируются из плиток (src/render/tileCache.ts), без него — рисуются прямо здесь; между слоями — машины своей
   * высоты: в тоннелях → земля → на земле → мосты → на мостах. Поверх — светофоры, анимации, подписи, оверлеи.
   */
  draw(game: Game, o: ToolOverlay): void {
    const ctx = this.ctx;
    // Каждый кадр — с исходного состояния холста (как и плитки): ничего не тянется из прошлого кадра.
    ctx.save();
    try {
      this.drawFrame(game, o);
    } finally {
      ctx.restore();
    }
  }

  private drawFrame(game: Game, o: ToolOverlay): void {
    const ctx = this.ctx;
    // Пульсирующая подсветка (предприятия из цепочек, место, машина в списке, станция выбранной машины, полоса
    // въезда, отказ фазы) и всплывающие суммы — меняются сами; остальное движущееся отмечают места, где его рисуют.
    this.moving =
      game.floaters.length > 0 ||
      o.highlight.length > 0 ||
      !!o.ping ||
      (o.fleetHover ?? null) !== null ||
      o.selection?.type === 'fleet' ||
      !!o.laneEdit?.from ||
      !!o.phaseEdit?.flash.length;
    this.ambient = false;
    this.refreshCache(game);
    this.hiddenSigns = o.hiddenSigns ?? null;
    this.blinkOn = game.speed === 0 || (game.time * BLINK_HZ) % 1 < 0.5;
    this.flash = (game.time * SIREN_HZ) % 1 < 0.5 ? -1 : 1;
    // Вода — вместе со светлой полосой берега (её рисуют на 7 шире).
    // Карта сменилась (новая партия, загрузка) — мосты над рекой считаем по её воде заново.
    if (this.waterOf !== game.terrain) {
      const terrain = game.terrain;
      this.waterOf = terrain;
      this.lanes.reset();
      this.projectLanes.reset();
      this.lanes.water = this.projectLanes.water = (p) => terrain.isWater(p, 7);
      // Дорога, уходящая за край карты, обрывается краем — без разворота на конце.
      this.lanes.inMap = this.projectLanes.inMap = (p) => terrain.inBounds(p, 1);
    }
    // Дороги — сеть полос (или её копия с тем, что сейчас строим), по слоям высоты; над рекой на земле — мостом.
    // Строящееся («Со строительством») — чертежом по всей сети (fullNet), дороги — по открытой для движения.
    const fullNet = o.roads?.net ?? game.roads.net;
    // Дороги на карте — как они на земле (openNet view): у перекрытия асфальт соседей не сужается отгоном.
    const roadNet = openNet(fullNet, true);
    // Стоп-линии и стрелки у перекрёстков, что правка меняет, — по сети с правкой, прямо во время протяжки.
    const preview = this.junctionPreview(game.roads.open, roadNet);
    const scene: StillScene = { game, o, roadNet, fullNet, preview };
    const cached = prefOn('mapCache');
    if (!cached && this.tiles.sets.length) this.forgetStill();
    // Сдвиг камеры — на целый пиксель холста: плитки кэша ложатся на экран без пересэмплирования, остальное — точно по ним.
    const cam = this.camera;
    const k = cam.zoom * cam.dpr;
    const tx = Math.round((cam.width / 2 - cam.x * cam.zoom) * cam.dpr);
    const ty = Math.round((cam.height / 2 - cam.y * cam.zoom) * cam.dpr);

    const view = this.view();
    const segs = [...game.net.segments.values()].filter((s) => this.visible(this.cache.get(s.id)!.bbox, view));
    const vehicles = [...game.traffic.vehicles.values()].filter(
      (v) => v.pos.x > view.x0 && v.pos.x < view.x1 && v.pos.y > view.y0 && v.pos.y < view.y1,
    );
    const band = (v: Vehicle) => v.layer ?? (v.level < -0.5 ? -1 : v.level < 0.5 ? 0 : v.level < 1.5 ? 1 : 2);

    const trains = this.trainCars(game, view);

    // Машины на линии портала тоннеля — по частям: за порталом бледно (под землёй), до него — как на земле. У портала
    // под землёй или на земле машину рисуют по её кузову, а не по слою движения: тот меняется с запасом, и на кадр
    // машина, уже целиком в тоннеле, моргала бы яркой.
    const portals = this.portalsOf(roadNet).filter((p) => p.pos.x > view.x0 - 60 && p.pos.x < view.x1 + 60 && p.pos.y > view.y0 - 60 && p.pos.y < view.y1 + 60);
    const atPortal = new Map<Vehicle, Portal>();
    const portalBand = new Map<Vehicle, number>();
    for (const v of vehicles) {
      if (band(v) > 0 || !portals.length) continue;
      const at = atPortals(portals, v.pos, v.dir, v.length);
      if (at?.side === 'split') atPortal.set(v, at.portal);
      else if (at) portalBand.set(v, at.side === 'in' ? -1 : 0);
    }
    const groundBand = (v: Vehicle) => portalBand.get(v) ?? band(v);
    // Мосты и эстакады: слои 1 и 2 — где есть дороги этого слоя (во всей сети) или пути в кадре.
    const levels = [1, 2].filter(
      (level) => this.lanes.hasLayer(roadNet, level) || this.projectLanes.hasLayer(fullNet, level) || segs.some((s) => this.railLevel(s, level)),
    );

    const plan = cached ? this.prepareTiles(scene, k, tx, ty) : null;
    if (plan) this.blitTiles(plan, UNDER);
    else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = BIOMES[game.terrain.biome].palette.outside;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(k, 0, 0, k, tx, ty);
      this.drawUnder(scene, view, segs);
    }
    ctx.setTransform(k, 0, 0, k, tx, ty);
    // Машины и поезда в тоннелях — бледно, под дорогами на земле.
    ctx.globalAlpha = 0.35;
    this.drawVehicles(vehicles.filter((v) => groundBand(v) === -1 && !atPortal.has(v)));
    for (const [v, p] of atPortal) this.drawClipped(portalHalf(p, 1), () => this.drawVehicles([v]));
    this.drawTrains(trains.filter((t) => t.layer === -1));
    ctx.globalAlpha = 1;
    if (plan) this.blitTiles(plan, GROUND);
    else this.drawGround(scene, view, segs);
    // На земле: переезды, сигналы, пробки, машины, порталы тоннелей, светофоры, движущееся у предприятий, станции, поезда.
    this.drawCrossings(game, view);
    this.drawSignals(game, view);
    if (o.heatmap) this.drawHeatmap(game, 0);
    // Пешеходы на переходах — вблизи, под машинами (машина, что их пропускает, — перед зеброй).
    this.drawPedestrians(game, view);
    this.drawGarageCars(game, view);
    this.drawVehicles(vehicles.filter((v) => groundBand(v) === 0 && !atPortal.has(v)));
    for (const [v, p] of atPortal) this.drawClipped(portalHalf(p, -1), () => this.drawVehicles([v]));
    this.drawPortals(portals);
    // Порталы тоннелей в проектах стройки — бледно, как и сама будущая дорога.
    const planned = this.projectPortals(fullNet).filter((p) => p.pos.x > view.x0 - 60 && p.pos.x < view.x1 + 60 && p.pos.y > view.y0 - 60 && p.pos.y < view.y1 + 60);
    if (planned.length) {
      ctx.globalAlpha = 0.5;
      this.drawPortals(planned);
      ctx.globalAlpha = 1;
    }
    // В крытый бокс машина заезжает под навес. Открытые посты рисуем с машинами поверх площадки.
    this.drawVehicles(game.enteringLooks().filter((v) => v.pos.x > view.x0 && v.pos.x < view.x1 && v.pos.y > view.y0 && v.pos.y < view.y1));
    this.drawLights(game, view, 0, o.phaseEdit);
    this.drawMotion(game, view);
    // Станции со складами: здания и платформы — неподвижным слоем (плитки кэша), под ним — автобусы у остановок,
    // поверх — посты цветом машин в них, ящики складов и автобусы на местах автовокзала.
    this.drawStationsUnder(game, view, o);
    if (plan) this.blitTiles(plan, STATIONS);
    else this.drawStationsStill(game, view, o);
    this.drawStationsOver(game, view);
    this.drawTrains(trains.filter((t) => t.layer === 0));
    for (const level of levels) {
      const roads = this.lanes.hasLayer(roadNet, level);
      if (plan) this.blitTiles(plan, GROUND + level);
      else this.drawBridges(scene, view, segs, level);
      // Пробки на мосту и съезде с него — поверх его полотна (с земли их закрыло бы полотно).
      if (roads && o.heatmap) this.drawHeatmap(game, level);
      // Машины на мосту — вместе с поднятым полотном (подъём — из движения: Vehicle.lift).
      this.drawVehicles(
        vehicles.filter((v) => band(v) === level),
        false,
        true,
      );
      // Светофоры у спуска с моста и на эстакаде — поверх её полотна и подняты вместе с ним.
      if (roads) this.drawLights(game, view, level, o.phaseEdit);
      // Поезд на пандусе и заехавший на него краем — над его полотном (пандус целиком в слое моста).
      this.drawTrains(trains.filter((t) => t.layer === level));
    }
    // Светофор перекрёстка под мостом не пропадает под полотном — приглушённым значком поверх.
    this.drawLights(game, view, 'covered', o.phaseEdit);
    // Краны строящихся предприятий — высокие: поверх станций, домов, дорог и мостов, под подписями и плашками.
    this.drawSiteCranes(game, view);
    this.drawConstruction(game, view, o.crewTarget != null ? { type: 'project', id: o.crewTarget } : o.selection);
    if (o.parkmap) this.drawParkmap(game, view);
    this.drawLabels(game, view);
    this.drawReceivers(game, view, o);
    this.drawOverlay(game, o);
    if (o.gradeMarks) this.drawGradeRungs(game, o);
    this.drawStationBadges(game, view, o.selection?.type === 'station' ? o.selection.id : null);
    this.drawWarningMarks(game, view);
    this.drawFloaters(game);
    if (o.buyDrop) this.drawBuyDrop(o.buyDrop, o.hover);
    if (o.label && o.hover) this.drawTooltip(o.hover, o.label.text, o.label.ok, o.label.warn);
    if (o.brush) this.drawBrush(o.brush);
    if (o.speedmap) this.drawSpeedLegend();
    if (o.roadTool && o.hover) this.drawHeight(game, o.hover, o.rise ?? null, o.heightText ?? null);
    // Скорость дороги под курсором — подписью там же и так же, как высота.
    else if (o.speedText && o.hover) this.drawHeight(game, o.hover, null, o.speedText);
    if (o.startHeight) this.drawStartHeight(o.startHeight.pos, o.startHeight.m, o.hover);
  }

  // ---------- Неподвижное: слои по высоте (на экран или в плитку кэша) ----------

  /** Путь в слое моста level (1 — мост, 2 — эстакада над ним). */
  private railLevel(s: Segment, level: number): boolean {
    const c = this.cache.get(s.id)!;
    return c.maxLevel > level - 0.99 && c.maxLevel <= level + 0.01;
  }

  /** Готовые дороги — без разворотов там, где их продолжает проект стройки (projectJoints): тупик там временный. */
  private openRoads(s: StillScene): { node: (id: number) => boolean } | undefined {
    const joints = projectJoints(s.roadNet, s.fullNet);
    return joints.size ? { node: (id) => !joints.has(id) } : undefined;
  }

  /** Земля: рельеф, вода, деревья, тоннели путей, откосы; дороги в тоннелях — бледно (машины в них — поверх). */
  private drawUnder(s: StillScene, view: Box, segs: Segment[]): void {
    const ctx = this.ctx;
    ctx.save();
    this.drawTerrain(s.game, view, s.o);
    // Строящиеся пути (ж/д проекты) — чертежом в своём проходе (drawRailProjects), не готовым тоннелем и откосом.
    const planned = segs.filter((x) => x.build);
    const built = planned.length ? segs.filter((x) => !x.build) : segs;
    this.drawTunnels(built);
    const ground = s.game.ground();
    // Вдоль тротуаров откосов нет: улица в городе спланирована (render/sidewalks.ts, spans).
    this.earthworks.draw(ctx, ground, s.roadNet, s.game.net, built, view, this.camera.zoom, s.game.terrain.version, undefined, this.sidewalks.spans);
    // Откосы проектов стройки — бледнее: насыпи и выемки ещё будут.
    if (buildingCorridors(s.fullNet).length || planned.length) {
      ctx.globalAlpha = 0.55;
      this.earthworks.draw(ctx, ground, s.fullNet, s.game.net, planned, view, this.camera.zoom, s.game.terrain.version, (c) => !!c.build);
    }
    ctx.globalAlpha = 0.35;
    this.lanes.draw(ctx, s.roadNet, this.camera.zoom, false, view, -1, this.openRoads(s));
    drawProjects(ctx, s.fullNet, this.projectLanes, this.camera.zoom, view, -1);
    ctx.restore();
  }

  /** На земле: пути, дороги с разметкой, площадки автостанций, знаки, дома и предприятия (без движущегося). */
  private drawGround(s: StillScene, view: Box, segs: Segment[]): void {
    const { game, o, roadNet, preview } = s;
    const ctx = this.ctx;
    ctx.save();
    const groundRails = segs.filter((x) => this.cache.get(x.id)!.maxLevel <= 0.01 && !x.build);
    // Месторождения и копоть у вредных предприятий — на земле, под путями и дорогами (enterpriseArt).
    this.drawEnterpriseGround(game, view);
    // Парки и скверы — под дорогами: дорога игрока через парк ложится поверх (parkArt).
    this.drawParks(game, view);
    // Тротуары вдоль улиц и дорожки кварталов — тоже под дорогами: у перекрёстков их закрывает полотно; дорожки —
    // слоем под тротуаром, одним с ним покрытием (townWalks).
    drawTownWalks(ctx, [...this.walks.values()], view, this.camera.zoom, this.sidewalks.lines, game.footpaths);
    // Щебень и шпалы под дорогой (на переезде асфальт сверху), рельсы — поверх асфальта.
    this.drawRailBeds(groundRails, false);
    drawProjectShadows(ctx, s.fullNet, this.projectLanes, this.camera.zoom, view, 0);
    this.lanes.draw(ctx, roadNet, this.camera.zoom, false, view, 0, this.openRoads(s));
    // Съезды к дворам, гаражам, стоянкам и площадкам — понижением бордюра поверх кромки полотна (townWalks).
    drawDriveMouths(ctx, [...this.walks.values()], view, this.camera.zoom);
    // Большие площадки — поверх своих тупиков-выездов: дорога видна до края площадки.
    this.drawLots(game, view, true);
    this.drawStationAprons(game, roadNet, view);
    // Проекты стройки — будущей дорогой с готовым до края работ (поверх земли, под подсветкой правки); базы стройки.
    drawProjects(ctx, s.fullNet, this.projectLanes, this.camera.zoom, view, 0);
    // Перестройка по полосам: прежняя дорога, где её ещё не разрыли, — поверх стройки (по ней едут), без площадок узлов.
    drawOldRoad(ctx, s.fullNet, roadNet, this.lanes, this.camera.zoom, view);
    drawRailProjects(ctx, game.net, segs, this.camera.zoom, 0);
    drawBases(ctx, game.construction.crews.bases.values(), view);
    if (o.roads) this.drawRoadPreview(o.roads);
    this.drawStopLines(game, view, 0, preview);
    drawTurnArrows(ctx, game, view, this.camera.zoom, preview);
    this.drawRailSteel(groundRails);
    if (o.speedmap) this.drawRailSpeedmap(groundRails);
    if (o.speedmap) this.drawSpeedmap(game, 0, view);
    this.drawCurveSigns(game, view, o.staleSigns, 0);
    // Аллеи вдоль проспектов и фонари вдоль улиц — поверх дорог (тень на асфальт), под домами.
    drawStreetGreen(ctx, this.alleys.shown, view, this.camera.zoom, BIOMES[game.terrain.biome].palette.trees);
    for (const { st, ind, path, box } of this.haulRoads(game)) {
      if (box.x1 >= view.x0 && box.x0 <= view.x1 && box.y1 >= view.y0 && box.y0 <= view.y1) {
        drawIndustryHaulConnection(ctx, st, ind, path);
      }
    }
    this.drawStill(game, view);
    ctx.restore();
  }

  /** Мосты и эстакады слоя level: полотна с тенью, стоп-линии и знаки на них, пути на эстакадах. */
  private drawBridges(s: StillScene, view: Box, segs: Segment[], level: number): void {
    const { game, o, roadNet, preview } = s;
    const ctx = this.ctx;
    const layer = segs.filter((x) => this.railLevel(x, level));
    // Строящиеся пути слоя — чертежом (drawRailProjects), не готовым мостом.
    const rails = layer.filter((x) => !x.build);
    const roads = this.lanes.hasLayer(roadNet, level);
    const projects = this.projectLanes.hasLayer(s.fullNet, level);
    if (!layer.length && !roads && !projects) return;
    ctx.save();
    // Тень мостов проектов — под готовыми полотнами слоя, как у готового моста.
    if (projects) drawProjectShadows(ctx, s.fullNet, this.projectLanes, this.camera.zoom, view, level);
    if (roads) this.lanes.draw(ctx, roadNet, this.camera.zoom, false, view, level, this.openRoads(s));
    // Мосты и эстакады проектов стройки — в своём слое, как готовые (с тенью и парапетом), но полупрозрачные.
    if (projects) drawProjects(ctx, s.fullNet, this.projectLanes, this.camera.zoom, view, level);
    if ((roads || projects) && o.roads) this.drawRoadPreview(o.roads, level);
    // Стоп-линии и скорость на мосту и съезде с него — поверх его полотна (с земли их закрыло бы полотно).
    if (roads) this.drawStopLines(game, view, level, preview);
    if (roads && o.speedmap) this.drawSpeedmap(game, level, view);
    this.drawElevated(rails);
    this.drawRailBeds(rails, true);
    this.drawRailSteel(rails);
    drawRailProjects(ctx, game.net, layer, this.camera.zoom, level);
    if (o.speedmap) this.drawRailSpeedmap(rails);
    if (roads) this.drawCurveSigns(game, view, o.staleSigns, level);
    ctx.restore();
  }

  // ---------- Кэш карты плитками ----------

  /**
   * Плитки на кадр: сброс устаревших, уровень зума, перерисовка — дыры сразу, остальное в бюджет кадра. Ответ —
   * что и откуда копировать на экран (blitTiles).
   */
  private prepareTiles(s: StillScene, k: number, tx: number, ty: number): TilePlan {
    const cam = this.camera;
    this.syncStill(s);
    const set = this.tiles.frame(cam.zoom, cam.dpr, performance.now());
    const a = cam.toWorld(0, 0);
    const b = cam.toWorld(cam.width, cam.height);
    // С пикселем запаса: сдвиг камеры округлён до целого пикселя — край экрана не останется без плитки.
    const screen: Box = grow({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }, 1 / k);
    // Про запас — полплитки вокруг экрана, и только когда уровень точно под зум (не во время зума).
    const steady = set.zoom === cam.zoom;
    const around = grow(screen, steady ? set.world / 2 : 0);
    const t0 = performance.now();
    let dirtyDone = 0;
    // Зум не устоялся (уровень растянут) — плитки под него будут, нужны ещё кадры; так же, если что-то отложено.
    if (!steady) this.moving = true;
    for (const job of this.tiles.jobs(set, screen, around)) {
      if (!job.must) {
        const spent = performance.now() - t0;
        // Устаревшая на экране — хотя бы одна за кадр, даже сверх бюджета: пока она не готова, её место рисуется
        // вживую (drawLive) — дороже копии.
        const budget = job.ahead ? AHEAD_MS : job.dirty ? DIRTY_MS : FILL_MS;
        if ((job.ahead && !steady) || (spent > budget && !(job.dirty && !job.ahead && dirtyDone === 0))) {
          this.moving = true;
          continue;
        }
      }
      this.renderTile(s, set, job.tile);
      if (job.dirty) dirtyDone++;
    }
    // Устаревшее (не успели перерисовать в бюджет) не показываем: его место — вживую, пока плитки не догонят.
    const { fresh: ready, holes: missing, live, fallback } = this.tiles.layout(set, screen);
    if (missing.length || live.length) this.moving = true;
    // Запасной уровень не нужен, когда текущий закрыл экран (пусть и устаревшими плитками).
    if (this.tiles.cover(set, screen).every((t) => t.ready)) this.tiles.dropFallback();
    const liveView = live.length ? grow(live.reduce(unite), TILE_MARGIN) : null;
    const liveSegs = liveView ? [...s.game.net.segments.values()].filter((x) => this.visible(this.cache.get(x.id)!.bbox, liveView)) : [];
    const aroundCount = this.tiles.cover(set, grow(screen, set.world / 2)).length;
    this.tiles.trim(Math.max(48, Math.ceil(aroundCount * 1.6)));
    return { set, ready, missing, fallback, live, scene: s, liveView, liveSegs, k, tx, ty };
  }

  /**
   * Слой layer неподвижного прямо в кадре — только в местах plan.live (устаревшие плитки), как без кэша: земля
   * (UNDER), на земле (GROUND), мосты уровня (GROUND + уровень).
   */
  private drawLive(plan: TilePlan, layer: number): void {
    if (!plan.liveView) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (const m of plan.live) {
      const x0 = Math.round(m.x0 * plan.k + plan.tx);
      const y0 = Math.round(m.y0 * plan.k + plan.ty);
      ctx.rect(x0, y0, Math.round(m.x1 * plan.k + plan.tx) - x0, Math.round(m.y1 * plan.k + plan.ty) - y0);
    }
    ctx.clip();
    const s = plan.scene;
    if (layer === UNDER) {
      ctx.fillStyle = BIOMES[s.game.terrain.biome].palette.outside;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.setTransform(plan.k, 0, 0, plan.k, plan.tx, plan.ty);
    if (layer === UNDER) this.drawUnder(s, plan.liveView, plan.liveSegs);
    else if (layer === GROUND) this.drawGround(s, plan.liveView, plan.liveSegs);
    else if (layer === STATIONS) this.drawStationsStill(s.game, plan.liveView, s.o);
    else this.drawBridges(s, plan.liveView, plan.liveSegs, layer - GROUND);
    ctx.restore();
  }

  /** Копирует слой layer плиток на экран (запасной уровень — только в дыры текущего), устаревшее — рисует вживую. */
  private blitTiles(plan: TilePlan, layer: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    const put = (set: TileSet<TileCanvasEl>, t: Tile<TileCanvasEl>) => {
      const c = t.layers[layer];
      if (!c) return;
      const r = tileRect(t.i, t.j, set.world, plan.k, plan.tx, plan.ty);
      // Без запаса по краям холста (TILE_PAD) — только сама плитка.
      ctx.drawImage(c.canvas, TILE_PAD, TILE_PAD, TILE_PX, TILE_PX, r.x, r.y, r.size, r.size);
    };
    if (plan.fallback.length) {
      ctx.save();
      ctx.beginPath();
      for (const m of plan.missing) {
        const x0 = Math.round(m.x0 * plan.k + plan.tx);
        const y0 = Math.round(m.y0 * plan.k + plan.ty);
        ctx.rect(x0, y0, Math.round(m.x1 * plan.k + plan.tx) - x0, Math.round(m.y1 * plan.k + plan.ty) - y0);
      }
      ctx.clip();
      for (const f of plan.fallback) for (const t of f.tiles) put(f.set, t);
      ctx.restore();
    }
    for (const t of plan.ready) put(plan.set, t);
    ctx.restore();
    this.drawLive(plan, layer);
  }

  /**
   * Рисует плитку t уровня set: каждый её слой — в свой холст (земля непрозрачная; с тоннелями земля под ними —
   * отдельным холстом), с тем же масштабом, что на экране, и с запасом вокруг (что заходит в плитку от соседей).
   */
  private renderTile(s: StillScene, set: TileSet<TileCanvasEl>, t: Tile<TileCanvasEl>): void {
    const view = grow(tileBox(t.i, t.j, set.world), TILE_MARGIN);
    const segs = [...s.game.net.segments.values()].filter((x) => this.visible(this.cache.get(x.id)!.bbox, view));
    // Слои тоннелей и мостов — и где они только в проектах стройки.
    const roadsIn = (level: number) => this.lanes.layerIn(s.roadNet, level, view) || this.projectLanes.layerIn(s.fullNet, level, view);
    const under = roadsIn(-1) || segs.some((x) => this.cache.get(x.id)!.minLevel < -0.4);
    const bridge = (level: number) => roadsIn(level) || segs.some((x) => this.railLevel(x, level));
    const k = set.zoom * set.dpr;
    const outside = BIOMES[s.game.terrain.biome].palette.outside;
    const screen = this.ctx;
    const zoom = this.camera.zoom;
    // Рисуют те же методы, что на экран: холст — плитки, зум — её уровня.
    this.camera.zoom = set.zoom;
    try {
      const paint = (layer: number, opaque: boolean | null, draw: () => void) => {
        const c = this.tiles.layer(t, layer, opaque);
        if (!c) return;
        const g = c.ctx;
        g.setTransform(1, 0, 0, 1, 0, 0);
        if (opaque) {
          g.fillStyle = outside;
          g.fillRect(0, 0, TILE_CANVAS, TILE_CANVAS);
        } else g.clearRect(0, 0, TILE_CANVAS, TILE_CANVAS);
        g.setTransform(k, 0, 0, k, TILE_PAD - t.i * TILE_PX, TILE_PAD - t.j * TILE_PX);
        this.ctx = g;
        draw();
      };
      paint(UNDER, under ? true : null, () => this.drawUnder(s, view, segs));
      paint(GROUND, !under, () => {
        if (!under) this.drawUnder(s, view, segs);
        this.drawGround(s, view, segs);
      });
      for (const level of [1, 2]) paint(GROUND + level, bridge(level) ? false : null, () => this.drawBridges(s, view, segs, level));
      // Станции — своим слоем (над машинами на земле), только где они есть.
      const stations = [...s.game.stations.values()].some((st) => (st.kind !== 'dock' && this.stationSeen(st, view)) || st.warehouses?.some((w) => seenAt(w.fp.center, view, 100)));
      paint(STATIONS, stations ? false : null, () => this.drawStationsStill(s.game, view, s.o));
    } finally {
      this.ctx = screen;
      this.camera.zoom = zoom;
    }
    t.ready = true;
    t.dirty = false;
  }

  /**
   * Что поменялось в нарисованном плитками с прошлого кадра — те плитки и устарели: слепки сети дорог (с подсветкой
   * стройки и знаками, что правка прячет), путей, домов городов, предприятий, площадок станций; правки рельефа.
   * Другая партия или карта — плитки заново; поменялся вид (настройки, изолинии при стройке) — устарели все.
   */
  private syncStill(s: StillScene): void {
    const { game, o, roadNet } = s;
    const t = game.terrain;
    let cur = this.still;
    const relief = !!o.roadTool && t.hasRelief;
    const speedmap = !!o.speedmap;
    const junctionMarks = prefOn('junctionMarks');
    if (cur.game !== game || cur.terrain !== t) {
      this.forgetStill();
      cur = this.still;
      cur.game = game;
      cur.terrain = t;
    } else if (cur.biome !== t.biome || cur.relief !== relief || cur.speedmap !== speedmap || cur.junctionMarks !== junctionMarks) this.tiles.invalidateAll();
    cur.biome = t.biome;
    cur.relief = relief;
    cur.speedmap = speedmap;
    cur.junctionMarks = junctionMarks;
    const boxes: Box[] = [];
    const add = (list: Box[]) => {
      for (const b of list) boxes.push(grow(b, DIRTY_PAD));
    };
    const pathsChanged = cur.footpaths !== game.footpaths;
    if (pathsChanged) {
      cur.footpaths = game.footpaths;
      add(this.diffs.footpaths.update(put => {
        for (const { id, a, b } of game.footpaths) put(id, `${a.x},${a.y},${b.x},${b.y}`, {
          x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
        });
      }));
    }
    const reliefBox = this.relief.sync(t);
    if (reliefBox === 'all') this.tiles.invalidateAll();
    else if (reliefBox) boxes.push(grow(reliefBox, DIRTY_PAD + 40));
    // Дороги на карте: полотна и узлы по подписи геометрии; у полотна — ещё подсветка стройки и бледные/спрятанные знаки.
    // Подсветка и знаки сверяются наборами (тот же массив или набор, что в прошлом кадре, — без сверки), без строк.
    const tintColor = o.roads ? TINT_KEYS[(o.roads.project ? 2 : 0) + (o.roads.ok ? 1 : 0)] : '';
    let marksChanged = tintColor !== cur.tintColor;
    cur.tintColor = tintColor;
    const changed = o.roads?.changed ?? null;
    if (changed !== cur.changedSrc) {
      cur.changedSrc = changed;
      const next = new Set(changed);
      if (!sameIds(cur.tint, next)) {
        cur.tint = next;
        marksChanged = true;
      }
    }
    const stale = o.staleSigns ?? null;
    if (stale !== cur.staleSrc) {
      cur.staleSrc = stale;
      if (!sameIds(cur.stale, stale)) {
        cur.stale = new Set(stale);
        marksChanged = true;
      }
    }
    const hidden = o.hiddenSigns ?? null;
    if (hidden !== cur.hiddenSrc) {
      cur.hiddenSrc = hidden;
      if (!sameIds(cur.hidden, hidden)) {
        cur.hidden = new Set(hidden);
        marksChanged = true;
      }
    }
    const tint = cur.tint;
    if (cur.net !== roadNet || cur.version !== roadNet.version || marksChanged) {
      cur.net = roadNet;
      cur.version = roadNet.version;
      const flag = (id: number) => (tint.has(id) ? `t${tintColor}` : '') + (cur.stale.has(id) ? 's' : '') + (cur.hidden.has(id) ? 'h' : '');
      add(
        this.diffs.corridors.update((put) =>
          this.lanes.eachItem(roadNet, (kind, id, sig, box) => {
            if (kind !== 'corridor') return;
            const f = flag(id);
            put(id, f ? `${sig}|${f}` : sig, box);
          }),
        ),
      );
      add(this.diffs.nodes.update((put) => this.lanes.eachItem(roadNet, (kind, id, sig, box) => kind === 'node' && put(id, sig, box))));
    }
    // Стройка (Construction.stamp: ход работ, площадки узлов, базы) или сеть с проектами поменялись — слепки стройки.
    const stamp = game.construction.stamp;
    if (cur.stamp !== stamp || cur.projectsFull !== s.fullNet || cur.projectsVersion !== s.fullNet.version || marksChanged) {
      cur.projectsFull = s.fullNet;
      cur.projectsVersion = s.fullNet.version;
      // Стройка: чертежи — по форме полотна (projectSig), с подсветкой правки; рамка — полотна. Ход работ (шаг этапа) —
      // только участок у края работ (progressBoxes): иначе шаг колонны перерисовывал плитки под всем полотном.
      const building = buildingCorridors(s.fullNet);
      const progress = new Map<number, { sig: string; spans: Spans }>();
      for (const c of building) {
        const sig = projectSig(c);
        const spans = drawnSpans(c);
        const was = this.progress.get(c.id);
        // Запас — сверх рамки участка (у неё свой, на ширину, мост и его тень): откосы и деревья от хода работ не меняются.
        if (was && was.sig === sig) for (const b of progressBoxes(c, was.spans, spans, siteKind(s.fullNet, c) === 'bridge')) boxes.push(grow(b, PROGRESS_PAD));
        progress.set(c.id, { sig, spans });
      }
      this.progress = progress;
      add(
        this.diffs.projects.update((put) => {
          for (const c of building) put(c.id, `${projectSig(c)}|${tint.has(c.id) ? tintColor : ''}`, projectBox(c));
          // Площадки узлов проектов — по дошедшему до них этапу, в своей рамке (шире рамки полотна); номера — отрицательные.
          for (const n of projectNodes(s.fullNet, this.projectLanes)) put(-n.id, `n${nodeStage(s.fullNet, this.projectLanes, n.id)}|${nodeReach(s.fullNet, this.projectLanes, n.id)}`, n.box);
        }),
      );
    }
    // Будущие дороги проектов — по отпечатку геометрии полотен и узлов (площадки перекрёстков шире рамки полотна).
    if (cur.full !== s.fullNet || cur.fullVersion !== s.fullNet.version) {
      cur.full = s.fullNet;
      cur.fullVersion = s.fullNet.version;
      add(this.diffs.projectItems.update((put) => this.projectLanes.eachItem(s.fullNet, (kind, id, sig, box) => put(`${kind[0]}${id}`, sig, box))));
    }
    if (cur.stamp !== stamp) {
      add(
        this.diffs.bases.update((put) => {
          for (const b of game.construction.crews.bases.values()) put(b.id, baseSig(b), baseBox(b));
        }),
      );
    }
    cur.stamp = stamp;
    // Ж/д проекты: чертёж и готовое по шагам (railProjectSig) — только строящиеся пути, когда стройка или пути менялись.
    if (cur.railsStamp !== stamp || cur.railsVersion !== game.net.version) {
      cur.railsStamp = stamp;
      cur.railsVersion = game.net.version;
      add(
        this.diffs.railProjects.update((put) => {
          for (const p of game.construction.projects.values()) {
            if (!p.rail) continue;
            for (const seg of game.construction.segmentsOf(p.id)) {
              const c = this.cache.get(seg.id);
              if (c) put(seg.id, railProjectSig(seg), c.bbox);
            }
          }
        }),
      );
    }
    if (cur.rails !== game.net.version) {
      cur.rails = game.net.version;
      add(
        this.diffs.rails.update((put) => {
          for (const seg of game.net.segments.values()) {
            const c = this.cache.get(seg.id)!;
            put(seg.id, `${c.rev}:${c.minLevel}:${c.maxLevel}`, c.bbox);
          }
        }),
      );
    }
    // Дома, парки и скверы города — когда их список заменили или он вырос (сверка — только после правки застройки,
    // площадок или раскладки: Game.townRev, lotRev, layoutRev).
    const net = game.roads.net;
    const lotChange = cur.lots !== game.lotRev;
    const layoutChange = cur.layout !== game.layoutRev;
    const roadChange = cur.townRoads !== net || cur.townRoadVersion !== net.version;
    const townsTouched = cur.towns !== game.townRev || lotChange || layoutChange || roadChange;
    cur.townRoads = net;
    cur.townRoadVersion = net.version;
    cur.towns = game.townRev;
    cur.lots = game.lotRev;
    cur.layout = game.layoutRev;
    let drivewayChange = lotChange || pathsChanged;
    for (const town of townsTouched ? game.towns : []) {
      let rec = this.diffs.towns.get(town.id);
      if (!rec) this.diffs.towns.set(town.id, (rec = { list: null, n: -1, parks: null, np: -1, lots: null, roads: '', diff: new SceneDiff() }));
      const parks = town.parks ?? null;
      // Площадки-стоянки: правка заменяет список (Game.lotRev) — заезды к их воротам (townWalks) тоже заново.
      const lots = town.lots ?? null;
      const previousWalks = this.walks.get(town.id);
      const samePlots = rec.list === town.buildings && rec.n === town.buildings.length && rec.parks === parks && rec.np === (parks?.length ?? 0) && rec.lots === lots;
      if (!roadChange && samePlots) continue;
      const r = town.extent ?? town.radius;
      const { x, y } = town.center;
      const area = grow(samePlots && previousWalks ? previousWalks.box : { x0: x - r, y0: y - r, x1: x + r, y1: y + r }, 30);
      const nearby = net.corridorsInBox(area.x0, area.y0, area.x1, area.y1).sort((a, b) => a.id - b.id);
      const roads = nearby.map((c) => `${c.id}:${c.rev}:${c.build ? 1 : 0}`).join(',');
      if (samePlots && rec.roads === roads) continue;
      rec.roads = roads;
      rec.list = town.buildings;
      rec.n = town.buildings.length;
      rec.parks = parks;
      rec.np = parks?.length ?? 0;
      rec.lots = lots;
      // Дорожки кварталов (townWalks) — по домам и паркам города: раз на их список, а не в каждой плитке.
      // Ближнее готовое полотно: от точки до его кромки (со своей стороны: полоса стоянки бывает только с одной).
      const nearest = (p: Vec) => {
        let best: { gap: number; dirt: boolean } = { gap: Infinity, dirt: false };
        for (const c of net.corridorsNear(p, 30)) {
          if (c.build) continue;
          if (!net.isFlat(c) || net.node(c.a).level !== 0) {
            if (Math.abs(net.heightAt(c, c.lut.closest(p).s)) > 0.25) continue;
          }
          const gap = curbGap(c, p);
          if (gap < best.gap) best = { gap, dirt: isDirt(c.cls) };
        }
        return best;
      };
      const walks = townWalks(
        town,
        (p) => nearest(p).gap,
        (p) => nearest(p).dirt ? 'dirt' : 'asphalt',
      );
      if (walks) this.walks.set(town.id, walks);
      else this.walks.delete(town.id);
      if (walks?.sig !== previousWalks?.sig) drivewayChange = true;
      add(
        rec.diff.update((put) => {
          // Рамка — с тенью и площадью у ратуши (houseArt): они выходят за контур дома. Этажи жилого — по жильцам; мест
          // скорой у больницы — по размеру города.
          for (const b of town.buildings) {
            const surfaces = walks?.driveColors?.get(b.id)?.map((d) => d.color).join(',') ?? '';
            put(b.id, `${fpSig(b.fp)}|${b.kind}|${b.floors}|${storeysOf(b)}|${b.color}|${b.roof}|${b.form}|${b.face}|${b.bays ?? ''}|${b.dockApproach ?? ''}|${surfaces}`, grow(fpBox(b.fp), houseReach(b)));
          }
          // Парки — отрицательными номерами (id парка — не id сущности).
          for (const p of parks ?? []) put(-p.id - 1, `${fpSig(p.fp)}|${p.kind}`, grow(fpBox(p.fp), PARK_REACH));
          // Площадки-стоянки — своими номерами (id сущности, со сдвигом от парков); снесённых нет.
          for (const l of town.lots ?? [])
            if (!l.removed) put(-2_000_000_000 + l.id, `${fpSig(l.fp)}|${l.gates.map((g) => `${g.x}${g.mode}`).join(',')}|${l.nodes?.length ?? 0}`, grow(fpBox(l.fp), LOT_REACH));
          if (walks) put(WALKS_KEY, walks.sig, walks.box);
        }),
      );
    }
    if (drivewayChange) {
      const lots = game.towns.flatMap((t) => (t.lots ?? []).filter((l) => !l.removed).map((l) => l.fp));
      this.drivewayOccupied = driveClearance(this.walks.values(), [...lots, ...game.footpaths.map(p => pathFootprint(p.a, p.b))]);
    }
    // Аллеи и тротуары: по дорогам, остановкам и строениям у бордюра, черте городов (с шагом 50 м — не каждый месяц) и
    // их застройке (тротуар — где рядом дома). Полотна, что не менялись, — из кэша (streetGreen); новая станция или
    // предприятие — пересчёт всех; вырос город — пересчёт его полотен. Перенесли дом или парк (Game.layoutRev) — тоже всех:
    // число домов и парков у полотна (подпись кэша тротуаров) то же, а стоят они уже не там.
    const al = this.alleys;
    const things =
      al.stations !== game.stations.size || al.industries !== game.industries.length || al.bases !== game.construction.crews.bases.size || al.layout !== game.layoutRev;
    let grown = false;
    if (al.townRev !== game.townRev) {
      al.townRev = game.townRev;
      const key = al.townKey;
      grown = key.length !== game.towns.length * 2;
      key.length = game.towns.length * 2;
      game.towns.forEach((t, i) => {
        const r = Math.floor(t.radius / 50);
        if (key[2 * i] !== r || key[2 * i + 1] !== t.buildings.length) grown = true;
        key[2 * i] = r;
        key[2 * i + 1] = t.buildings.length;
      });
    }
    if (things || grown || drivewayChange || al.net !== net.version) {
      al.net = game.roads.net.version;
      // Кэш — по полотнам; снесённых накопилось много — с чистого листа.
      if (things || drivewayChange || al.cache.size > net.corridors.size * 2 + 200) al.cache.clear();
      if (game.layoutRev !== this.layoutSeen) {
        this.layoutSeen = game.layoutRev;
        this.sidewalkCache.clear();
      }
      al.stations = game.stations.size;
      al.industries = game.industries.length;
      al.bases = game.construction.crews.bases.size;
      al.layout = game.layoutRev;
      const index = game.index;
      this.alleys.towns = game.towns.map((t) => ({ center: t.center, radius: Math.floor(t.radius / 50) * 50 }));
      this.alleys.lines = streetGreen(net, this.alleys.towns, (p, r) => index.at(p, r) !== null || this.drivewayOccupied(p, r * 1.1), this.alleys.cache);
      // Тротуары и скругления углов кварталов (render/sidewalks.ts).
      this.walkBase = gameSidewalks(game);
    }
    // Аллеи — так же: на протяжке правки — по сети с правкой (деревья не остаются на сдвинутом полотне и на скруглённом
    // углу), отпустили или отменили — снова по сети игры. Слепок по полотнам сбрасывает плитки только там, где аллея другая.
    const trees = this.liveAlleys(game, s.fullNet);
    if (trees !== this.alleys.shown) {
      this.alleys.shown = trees;
      const pad = this.alleys.live ? WALK_PAD : DIRTY_PAD;
      for (const b of this.diffs.alleys.update((put) => trees.forEach((l) => put(l.id, l.sig, l.box)))) boxes.push(grow(b, pad));
    }
    // Правка дорог в предпросмотре (тянут узел или дорогу, крутят угол перекрёстка, ведут новую): тротуары, что она
    // меняет, — по сети с правкой, прямо во время протяжки; прежние — прочь. Слепок по ключам (`c<id>`, `n<id>`)
    // сбрасывает плитки только под ними — без двойных тротуаров и дыр; отпустили или отменили — снова по сети игры.
    const shown = this.liveSidewalks(game, s.fullNet);
    if (shown !== this.sidewalks) {
      this.sidewalks = shown;
      // На протяжке (каждый кадр) запас — меньше DIRTY_PAD: тротуар не отбрасывает тени и не прячет деревья, а откосы у
      // концов тротуаров (spans) — у самой улицы, её плитки и так сбрасывает асфальт; лишние плитки — лишние миллисекунды.
      const pad = this.walkLive ? WALK_PAD : DIRTY_PAD;
      for (const b of this.diffs.sidewalks.update((put) => shown.lines.forEach((l) => put(l.key, l.sig, l.box)))) boxes.push(grow(b, pad));
    }
    // Предприятия и месторождения — только после их правки (Game.industryRev: запасы, выпуск, уровень, стройка…).
    if (cur.industries !== game.industryRev) {
      cur.industries = game.industryRev;
      add(
        this.diffs.industries.update((put) => {
          // Вредное — вместе с копотью вокруг и посеревшими домами в радиусе вреда (enterpriseArt).
          for (const ind of game.industries)
            put(ind.id, `${industrySig(ind)}|${enterpriseSig(ind)}`, grow((ind.annexes ?? []).reduce((box, x) => unite(box, fpBox(x.fp)), fpBox(ind.fp)), enterpriseReach(ind)));
        }),
      );
      add(
        this.diffs.deposits.update((put) => {
          for (const d of game.enterprises.deposits) put(d.id, depositSig(d), depositBox(d));
        }),
      );
    }
    // Технологические проезды могут выходить далеко за границы самой станции.
    const previousHaulRoads = this.haulRoadCache.list;
    const haulRoads = this.haulRoads(game);
    if (haulRoads !== previousHaulRoads || this.diffs.haulRoads.size !== haulRoads.length) {
      add(this.diffs.haulRoads.update((put) => {
        for (const { st, path, box } of haulRoads) put(st.id, `${st.fp.angle}|${path.map(({ x, y }) => `${x},${y}`).join('|')}`, box);
      }));
    }
    // Площадки автостанций — после правки станций (Game.stationRev).
    if (cur.stations !== game.stationRev) {
      cur.stations = game.stationRev;
      add(
        this.diffs.aprons.update((put) => {
          for (const x of game.stations.values()) if (x.kind === 'road') {
            const apron = x.industryId !== null && !x.curb ? Math.max(36, industryApronEnd(x.fp.h) - x.fp.h / 2) : 0;
            put(x.id, `${fpSig(x.fp)}|${x.bays}|${x.nodeId}|${x.industryId}|${x.depots ?? 0}`, grow(fpBox(x.fp), apron));
          }
        }),
      );
    }
    // Неподвижное станций (слой STATIONS) — после правки станций, дорог (узел выезда) или путей (платформы вокзала) и
    // когда сменился выбор (выбранная станция, её пара, остановки выбранной линии — синей обводкой).
    const sel = o.selection?.type === 'station' ? o.selection.id : null;
    let picked = sel !== cur.picked;
    if (o.lineStops !== cur.lineStopsSrc) {
      cur.lineStopsSrc = o.lineStops;
      if (o.lineStops.length !== cur.lineStops.length || o.lineStops.some((id, i) => id !== cur.lineStops[i])) {
        cur.lineStops = [...o.lineStops];
        picked = true;
      }
    }
    if (picked || cur.stationsStill !== game.stationRev || cur.stationRoads !== game.roads.net.version || cur.stationRails !== game.net.version) {
      cur.picked = sel;
      cur.stationsStill = game.stationRev;
      cur.stationRoads = game.roads.net.version;
      cur.stationRails = game.net.version;
      const isPicked = this.stationPicked(game, o);
      for (const b of this.diffs.stations.update((put) => {
        for (const x of game.stations.values()) if (x.kind !== 'dock' || x.warehouses?.length) put(x.id, this.stationSig(game, x, isPicked(x)), this.stationBox(x));
      }))
        boxes.push(grow(b, 10));
    }
    if (boxes.length) this.tiles.invalidate(boxes);
  }

  /**
   * Стройка поверх карты (динамически, не в плитках): у края работ — каток с мигающим маячком (пока стройка идёт),
   * над проектом — плашка «🏗 45%» (на паузе — «⏸», без денег — «💸»).
   */
  private drawConstruction(game: Game, view: Box, sel: Selection | null): void {
    const selected = sel?.type === 'project' ? sel.id : null;
    const crews = game.construction.crews;
    const ctx = this.ctx;
    // Свободные бригады — на своей базе.
    for (const base of crews.bases.values()) {
      if (base.fp.center.x < view.x0 - 40 || base.fp.center.x > view.x1 + 40 || base.fp.center.y < view.y0 - 40 || base.fp.center.y > view.y1 + 40) continue;
      // Выбранная база (её карточка справа) — в оранжевой рамке.
      if (sel?.type === 'base' && sel.id === base.id) {
        const z = this.camera.zoom;
        ctx.save();
        ctx.translate(base.fp.center.x, base.fp.center.y);
        ctx.rotate(base.fp.angle);
        ctx.strokeStyle = 'rgba(240, 138, 60, 0.9)';
        ctx.lineWidth = 2.5 / z + 1;
        const pad = 3 + 3 / z;
        ctx.strokeRect(-base.fp.w / 2 - pad, -base.fp.h / 2 - pad, base.fp.w + 2 * pad, base.fp.h + 2 * pad);
        ctx.restore();
      }
      drawParked(ctx, base, crews.of(base.id).filter((b) => b.state === 'idle').length);
    }
    // Проектов может уже не быть, а техника ещё стоит на достроенной дороге (выезжает в поток с мест) — её рисуем всё равно.
    // Сводка проектов — одна на кадр: и для техники, и для плашек (projectBadges).
    const list = game.construction.list();
    const z = this.camera.zoom;
    const going = game.speed > 0;
    const lights: { site: Corridor; working: boolean }[] = [];
    for (const info of list) {
      const p = info.project;
      const working = going && !p.paused && p.stalled === undefined;
      const cs = game.construction.corridorsOf(p.id);
      const crew = crews.working(p.id).length;
      // Выбранный проект (его карточка справа) — под техникой оранжевой полупрозрачной полосой шире полотна.
      if (selected === p.id) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(240, 138, 60, 0.32)';
        for (const c of cs) {
          ctx.lineWidth = 2 * corridorHalf(c) + 10 + 6 / z;
          ctx.beginPath();
          c.lut.points.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
          ctx.stroke();
        }
        // Ж/д проект — его строящиеся пути.
        for (const s of p.rail ? game.construction.segmentsOf(p.id) : []) {
          ctx.lineWidth = 2 * RAIL_HALF + 10 + 6 / z;
          ctx.beginPath();
          s.lut.points.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
          ctx.stroke();
        }
        ctx.restore();
      }
      const net = game.roads.net;
      // У каждого фронта (участка в работе) — своё: мост — кран и бетоновоз у края пролёта; тоннель — техника за
      // порталом видна призраком сквозь землю (tunnelSight, drawInSight), у входного портала — проходческое хозяйство,
      // края работ — огоньками (structureArt).
      for (const site of crew ? game.construction.fronts(p.id) : []) {
        if (siteKind(net, site) !== 'tunnel') continue;
        const gate = entryPortal(net, site);
        if (gate && seenAt(gate.pos, view, 60)) drawPortalGear(ctx, gate, game.time, working);
        // Огоньки у краёв работ — поверх техники-призрака: их видно сквозь землю ярко (техника — ниже, после проектов).
        lights.push({ site, working });
      }
    }
    // Техника бригад — каждая машина там, где она есть (Game.siteCrewLooks: по полосе бригады от подъезда к своему
    // месту в колонне этапов и у края работ, вдоль стройки, ждёт выезда) — тем же рисунком, что в потоке. Отсыпку
    // моста и тоннеля на участке ведут кран и щит (drawMachines); в тоннеле — за порталом призраком сквозь землю.
    const net = game.roads.net;
    for (const v of game.siteCrewLooks()) {
      if (!seenAt(v.pos, view, 40)) continue;
      const c = v.site !== undefined ? net.corridors.get(v.site) : undefined;
      const kind = c ? siteKind(net, c) : 'road';
      const draw =
        v.stage === 0 && kind !== 'road'
          ? (g: CanvasRenderingContext2D) => drawMachines(g, v.pos, v.dir, 0, !!v.beacon, 0, kind, game.time)
          : (g: CanvasRenderingContext2D) => {
              // Призрак рисуется в приглушённый холст (drawInSight): машины — тем же методом, что в потоке.
              const keep = this.ctx;
              this.ctx = g;
              try {
                this.drawVehicles([v]);
              } finally {
                this.ctx = keep;
              }
            };
      drawInSight(ctx, tunnelSight(net, v.pos, v.dir, v.length), draw);
    }
    for (const l of lights) drawWorkLights(ctx, l.site, game.time, l.working);
    // Ж/д проекты: техника строительного поезда у краёв этапов (сам поезд — среди поездов, у края готового пути).
    for (const info of list) {
      const p = info.project;
      const site = p.rail ? game.construction.trains?.site(p.id) : null;
      const seg = site && game.net.segments.get(site.seg);
      if (!site || !seg || !seenAt(seg.lut.pointAt(seg.length / 2), view, seg.length / 2 + 40)) continue;
      const back = site.back !== null ? (game.net.segments.get(site.back) ?? null) : null;
      drawTrackMachines(ctx, seg, site.spans, site.fromB, game.time, going && !p.paused && p.stalled === undefined, back, {
        n: WORK_TRAIN.cars,
        len: WORK_TRAIN.carLength,
        color: WORK_TRAIN.color,
        load: WORK_TRAIN.load,
      });
    }
    // Перекрытия перестройки: щиты у концов закрытого и конусы вдоль открытых полос (rebuild.ts, closure.ts).
    drawClosures(ctx, net, this.projectLanes.cutsOf(net), z, view, (id, flow) => game.workSignals.lamp(id, flow));
    // Плашки над проектами — при любом зуме одного размера на экране (projectBadges: клик по плашке ищет её там же).
    for (const b of projectBadges(game, z, list)) {
      if (b.x < view.x0 - 200 || b.x > view.x1 + 200 || b.y < view.y0 - 200 || b.y > view.y1 + 200) continue;
      ctx.save();
      ctx.font = `600 ${12 / z}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = this.textWidth(b.text) + 12 / z;
      const h = 2 * b.hh;
      ctx.fillStyle = b.fill;
      ctx.beginPath();
      ctx.roundRect(b.x - w / 2, b.y - h / 2, w, h, h / 2);
      ctx.fill();
      if (selected === b.id) {
        ctx.lineWidth = 2.5 / z;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(b.text, b.x, b.y + 0.5 / z);
      ctx.restore();
    }
  }

  /** Высота у начала дороги — позади начала (против хода к курсору), за краем полотна, чтобы не ложиться на него. */
  private drawStartHeight(p: Vec, m: number, hover: Vec | null): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const dx = hover ? hover.x - p.x : 1;
    const dy = hover ? hover.y - p.y : 0;
    const l = Math.hypot(dx, dy) || 1;
    // Отступ: полуширина широкой дороги (м) и ещё немного на экране.
    const back = 16 + 8 / z;
    const x = p.x - (dx / l) * back;
    const y = p.y - (dy / l) * back;
    const label = altitudeText(m);
    ctx.save();
    ctx.font = `600 ${12 / z}px sans-serif`;
    // Дорога уходит вправо — подпись слева от точки, влево — справа, почти вертикально — над или под ней.
    const side = Math.abs(dx / l) > 0.35;
    ctx.textAlign = side ? (dx > 0 ? 'right' : 'left') : 'center';
    ctx.textBaseline = side ? 'middle' : dy > 0 ? 'bottom' : 'top';
    ctx.lineWidth = 3 / z;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.strokeText(label, x, y);
    ctx.fillStyle = 'rgba(70, 56, 30, 0.95)';
    ctx.fillText(label, x, y);
    ctx.restore();
  }

  /** Порталы тоннелей сети (кэш по версии сети). */
  private portalsOf(net: LaneNet): Portal[] {
    const c = this.portalCache;
    if (c && c.net === net && c.version === net.version) return c.list;
    const list = tunnelPortals(net);
    this.portalCache = { net, version: net.version, list };
    return list;
  }

  /** Порталы тоннелей строящихся полотен сети (кэш по версии сети). */
  private projectPortals(net: LaneNet): Portal[] {
    const c = this.projectPortalCache;
    if (c && c.net === net && c.version === net.version) return c.list;
    const list = tunnelPortals(net, buildingCorridors(net));
    this.projectPortalCache = { net, version: net.version, list };
    return list;
  }

  /** Рисует draw только внутри многоугольника clip. */
  private drawClipped(clip: Vec[], draw: () => void): void {
    const ctx = this.ctx;
    ctx.save();
    this.polyline(clip);
    ctx.closePath();
    ctx.clip();
    draw();
    ctx.restore();
  }

  /**
   * Въезды в тоннели: тёмный зев внутрь (тень под сводом) и бетонный оголовок поперёк дороги по линии портала
   * с откосными стенками наружу — видно, куда машины ныряют под землю.
   */
  private drawPortals(portals: Portal[]): void {
    const ctx = this.ctx;
    ctx.save();
    for (const p of portals) {
      const n = rightNormal(p.dir);
      const at = (lat: number, along: number) => add(add(p.pos, scale(n, lat)), scale(p.dir, along));
      // Зев: от линии портала внутрь темнеет и сходит на нет.
      const g = ctx.createLinearGradient(p.pos.x, p.pos.y, p.pos.x + p.dir.x * 9, p.pos.y + p.dir.y * 9);
      g.addColorStop(0, 'rgba(24, 26, 30, 0.6)');
      g.addColorStop(1, 'rgba(24, 26, 30, 0)');
      ctx.fillStyle = g;
      this.polyline([at(p.left, 0), at(p.right, 0), at(p.right, 9), at(p.left, 9)]);
      ctx.closePath();
      ctx.fill();
      // Оголовок и откосные стенки: стенки расходятся от краёв портала наружу, по склону выемки.
      const wall = [at(p.left - 4, -5), at(p.left - 1.2, 0), at(p.right + 1.2, 0), at(p.right + 4, -5)];
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const [color, width] of [
        ['rgba(40, 38, 34, 0.35)', 3.4],
        ['#8c877c', 2.4],
        ['#d6d1c4', 1.1],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        this.polyline(wall);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Круг кисти рельефа: сплошной край и пунктир на половине радиуса — там мазок ещё сильный. */
  private drawBrush(b: { pos: Vec; r: number; ok: boolean }): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    ctx.save();
    ctx.strokeStyle = b.ok ? 'rgba(120, 84, 40, 0.9)' : 'rgba(232, 72, 63, 0.9)';
    ctx.fillStyle = b.ok ? 'rgba(160, 120, 60, 0.12)' : 'rgba(232, 72, 63, 0.1)';
    ctx.lineWidth = 2 / z;
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([5 / z, 4 / z]);
    ctx.lineWidth = 1.2 / z;
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, b.r * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Высота рельефа под курсором — и до начала дороги, и пока тянем её конец; над подсказкой стройки, чтобы её не закрывать.
   * rise — заданная −/+ высота конца относительно начала: следом, тем же шрифтом, синим. text — своя подпись
   * вместо высоты земли (над мостом — и моста, и земли под ним; на карте скоростей в «Выборе» — скорость дороги).
   */
  private drawHeight(game: Game, p: Vec, rise: string | null, text: string | null = null): void {
    const label = text ?? heightLabel(game.terrain, p);
    if (!label) return;
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const x = p.x + 12 / z;
    const y = p.y - 30 / z;
    ctx.save();
    ctx.font = `600 ${12 / z}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3 / z;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.strokeText(label, x, y);
    ctx.fillStyle = 'rgba(70, 56, 30, 0.95)';
    ctx.fillText(label, x, y);
    if (rise) {
      // Тем же шрифтом, что высота, — отличается только цветом.
      const rx = x + ctx.measureText(label).width + 5 / z;
      ctx.strokeText(rise, rx, y);
      ctx.fillStyle = '#1f6fd6';
      ctx.fillText(rise, rx, y);
    }
    ctx.restore();
  }

  // ---------- Кэш геометрии путей ----------

  /** Пересобирает кэш только для изменившихся участков. */
  private refreshCache(game: Game): void {
    if (this.cacheVersion === game.net.version) return;
    this.cacheVersion = game.net.version;
    for (const id of [...this.cache.keys()]) if (!game.net.segments.has(id)) this.cache.delete(id);
    for (const s of game.net.segments.values()) {
      if (this.cache.get(s.id)?.rev !== s.rev) this.cache.set(s.id, this.buildCache(game, s));
    }
  }

  private buildCache(game: Game, s: Segment): SegCache {
    const net = game.net;
    const width = halfWidth(s.spec) * 2;
    const surface = s.lut.offsetPolyline(0, 0, s.length, 3);
    const heights = surface.map((_, i) => net.levelAt(s, (s.length * i) / Math.max(1, surface.length - 1)));
    // Рельсы и шпалы — по всей длине, через узлы стрелок без разрывов; в тоннеле их не видно.
    const la = net.node(s.a).level;
    const lb = net.node(s.b).level;
    const cut = la === lb ? null : (-0.4 - la) / (lb - la);
    let v0 = 0;
    let v1 = s.length;
    if (la < -0.4 && lb < -0.4) v1 = 0;
    else if (cut !== null && cut > 0 && cut < 1) {
      if (la < -0.4) v0 = cut * s.length;
      else v1 = cut * s.length;
    }
    const sleepers: Vec[] = [];
    for (let at = v0 + 2; at < v1 - 1; at += 4.5) {
      const p = s.lut.pointAt(at);
      const t = s.lut.tangentAt(at);
      sleepers.push({ x: p.x - t.y * 4.3, y: p.y + t.x * 4.3 }, { x: p.x + t.y * 4.3, y: p.y - t.x * 4.3 });
    }
    const rails = v1 > v0 ? [s.lut.offsetPolyline(2.4, v0, v1, 3), s.lut.offsetPolyline(-2.4, v0, v1, 3)] : [];
    const hw = width / 2 + 8;
    const xs = surface.map((p) => p.x);
    const ys = surface.map((p) => p.y);
    let wet = false;
    for (let i = 0; i < surface.length; i += 3) if (game.terrain.isWater(surface[i], 0)) wet = true;
    return {
      surface,
      width,
      heights,
      rail: { rails, sleepers },
      bbox: { x0: Math.min(...xs) - hw, y0: Math.min(...ys) - hw, x1: Math.max(...xs) + hw, y1: Math.max(...ys) + hw },
      maxLevel: Math.max(...heights),
      minLevel: Math.min(...heights),
      wet,
      rev: s.rev,
    };
  }

  /** Деревья под путями, дорогами (кроме тоннелей), строениями и в кольцах прячутся. */
  private refreshTrees(game: Game): void {
    const key = `${game.net.version}:${game.roads.net.version}:${game.index.items.size}`;
    if (key === this.treeVersion) return;
    this.treeVersion = key;
    // Кто прячет деревья — кружками; пересчитываются только деревья там, где кто-то из них поменялся (TreeCover).
    const hiders: Hiders = new Map();
    for (const s of game.net.segments.values()) {
      const c = this.cache.get(s.id);
      if (!c || c.minLevel < -0.6) continue;
      const r = c.width / 2 + 6;
      let rail = this.treeRails.get(c);
      if (!rail) {
        rail = [];
        for (let i = 0; i < c.surface.length; i += 2) rail.push(c.surface[i].x, c.surface[i].y, r);
        this.treeRails.set(c, rail);
      }
      hiders.set(`r${s.id}`, rail);
    }
    // Кружки вдоль полотна (кроме тоннелей) — один раз на его форму и высоты концов.
    const roads = game.roads.net;
    for (const c of roads.corridors.values()) {
      const na = roads.node(c.a);
      const nb = roads.node(c.b);
      const ck = `${c.rev}:${na.level}:${nb.level}`;
      let cut = this.treeCuts.get(c.id);
      if (cut?.key !== ck) {
        const pts: number[] = [];
        for (const s of axisStations(c, 0, c.length, 6)) {
          const e = edgesAt(c, s);
          if (!e || roads.heightAt(c, s) < -0.6) continue;
          const p = pointOff(c, s, (e[0] + e[1]) / 2);
          pts.push(p.x, p.y, (e[1] - e[0]) / 2 + 6);
        }
        this.treeCuts.set(c.id, (cut = { key: ck, pts }));
      }
      hiders.set(`c${c.id}`, cut.pts);
    }
    if (this.treeCuts.size > roads.corridors.size + 500) for (const id of [...this.treeCuts.keys()]) if (!roads.corridors.has(id)) this.treeCuts.delete(id);
    for (const n of roads.nodes.values()) {
      if (!n.corners || n.kind !== 'junction' || n.level < -0.6) continue;
      const pk = `${Object.entries(n.corners).join(';')}|${n.corridors.map((id) => roads.corridors.get(id)?.rev).join(',')}`;
      let cut = this.treePlates.get(n.id);
      if (cut?.key !== pk) {
        const plate = junctionPlate(roads, n);
        this.treePlates.set(n.id, (cut = { key: pk, pts: plate ? polygonHiders(plate, 6) : [] }));
      }
      hiders.set(`j${n.id}`, cut.pts);
    }
    for (const id of [...this.treePlates.keys()]) if (!roads.nodes.get(id)?.corners) this.treePlates.delete(id);
    for (const it of game.index.items) {
      // Кружок строения — прежним массивом, пока оно на месте (тогда сверка с прошлым разом — сразу).
      const { center, w, h } = it.fp;
      let item = this.treeItems.get(it);
      if (!item || item.pts[0] !== center.x || item.pts[1] !== center.y || item.w !== w || item.h !== h) {
        item = { pts: [center.x, center.y, Math.hypot(w, h) / 2 + 4], w, h };
        this.treeItems.set(it, item);
      }
      hiders.set(it, item.pts);
    }
    for (const [id, c] of game.roundaboutCenters) hiders.set(`o${id}`, [c.x, c.y, 50]);
    this.treeCover.update(game.terrain.trees, hiders);
  }

  // ---------- Рельеф ----------

  private drawTerrain(game: Game, view: ReturnType<Renderer['view']>, o: ToolOverlay): void {
    const ctx = this.ctx;
    const t = game.terrain;
    // Трава, деревья и вне карты — по биому (у средней полосы — прежние цвета).
    const pal = BIOMES[t.biome].palette;
    ctx.fillStyle = pal.grass;
    ctx.fillRect(0, 0, t.width, t.height);
    // Цвет земли по высоте, отмывка и изолинии — под водой, дорогами и застройкой: рисуются раньше них.
    this.relief.drawGround(ctx, t, view);
    this.relief.drawContours(ctx, t, view, this.camera.zoom, o.roadTool);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, t.width, t.height);
    ctx.clip();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [color, extra] of [
      [C.bank, 14],
      [C.water, 0],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      // С рельефом берега рек и озёр идут по рельефу — вода одним контуром из поля расстояний до берега.
      const shaped = waterPath(t, extra / 2);
      if (shaped) {
        ctx.fill(shaped, 'evenodd');
        continue;
      }
      for (const r of t.rivers) {
        ctx.lineWidth = r.width + extra;
        ctx.beginPath();
        smoothPath(ctx, r.points);
        ctx.stroke();
      }
      for (const lake of t.lakes) {
        ctx.beginPath();
        ctx.arc(lake.center.x, lake.center.y, lake.radius + extra / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    this.refreshTrees(game);
    if (this.camera.zoom < 0.18) return;
    for (const tree of t.trees) {
      if (tree.hidden) continue;
      const p = tree.pos;
      if (p.x < view.x0 || p.x > view.x1 || p.y < view.y0 || p.y > view.y1) continue;
      const size = tree.size * pal.treeScale;
      if (this.drivewayOccupied(p, size)) continue;
      ctx.fillStyle = 'rgba(40, 60, 30, 0.16)';
      ctx.beginPath();
      ctx.arc(p.x + 2 * pal.treeScale, p.y + 2.5 * pal.treeScale, size, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = pal.trees[Math.floor(tree.shade * pal.trees.length)];
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------- Дороги ----------

  private polyline(pts: readonly Vec[]): void {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  }

  private drawTunnels(segs: Segment[]): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineCap = 'butt';
    for (const s of segs) {
      const c = this.cache.get(s.id)!;
      if (c.minLevel > -0.4) continue;
      const parts = this.splitBy(c, (h) => h < -0.4);
      ctx.strokeStyle = 'rgba(60, 66, 74, 0.35)';
      ctx.lineWidth = c.width + 2;
      for (const part of parts) {
        this.polyline(part);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Куски полилинии, где условие по высоте выполняется. */
  private splitBy(c: SegCache, pred: (h: number) => boolean): Vec[][] {
    const parts: Vec[][] = [];
    let cur: Vec[] = [];
    c.surface.forEach((p, i) => {
      if (pred(c.heights[i])) cur.push(p);
      else if (cur.length) {
        cur.push(p);
        parts.push(cur);
        cur = [];
      }
    });
    if (cur.length > 1) parts.push(cur);
    return parts;
  }

  /** Мосты и эстакады путей: тень со смещением по высоте, опоры и настил. */
  private drawElevated(segs: Segment[]): void {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Пандус с земли: тень — с середины подъёма.
    const isFoot = (c: SegCache) => c.minLevel > -0.01 && c.minLevel <= 0.01;
    ctx.fillStyle = C.shadow;
    for (const s of segs) {
      const c = this.cache.get(s.id)!;
      ctx.strokeStyle = C.shadow;
      ctx.lineWidth = c.width;
      ctx.lineCap = isFoot(c) ? 'butt' : 'round';
      ctx.beginPath();
      let first = true;
      c.surface.forEach((p, i) => {
        const h = Math.max(0, c.heights[i]);
        if (isFoot(c) && h < 0.5) return;
        const x = p.x + h * 6;
        const y = p.y + h * 9;
        if (!first) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        first = false;
      });
      ctx.stroke();
    }
    // Опоры.
    ctx.fillStyle = C.pillar;
    for (const s of segs) {
      const c = this.cache.get(s.id)!;
      for (let i = 6; i < c.surface.length - 3; i += 12) {
        if (c.heights[i] < 0.6) continue;
        const p = c.surface[i];
        const h = c.heights[i];
        ctx.fillRect(p.x - 2.5, p.y - 2.5, 5 + h * 6, 5 + h * 9);
      }
    }
    for (const pass of [0, 1]) {
      for (const s of segs) {
        const c = this.cache.get(s.id)!;
        const parts = c.minLevel < 0.2 ? this.splitBy(c, (h) => h >= -0.4) : [c.surface];
        // Пандус с земли обрезан ровно по узлу у земли: скруглённый край настила лёг бы на путь до него (и на поезд
        // там); у моста — скругление кругом, стык с соседним пролётом без щели.
        const foot = isFoot(c);
        ctx.lineCap = foot ? 'butt' : 'round';
        ctx.strokeStyle = pass === 0 ? C.rail : C.deck;
        ctx.lineWidth = c.width + (pass === 0 ? 5 : 0);
        for (const part of parts) {
          this.polyline(part);
          ctx.stroke();
        }
        if (foot) {
          ctx.fillStyle = ctx.strokeStyle;
          for (const i of [0, c.surface.length - 1]) {
            if (c.heights[i] < 0.5) continue;
            ctx.beginPath();
            ctx.arc(c.surface[i].x, c.surface[i].y, ctx.lineWidth / 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
    ctx.lineCap = 'round';
  }

  /** Насыпь со щебнем и шпалы; на мосту и эстакаде — только шпалы на настиле. */
  private drawRailBeds(segs: Segment[], elevated: boolean): void {
    if (!segs.length) return;
    const ctx = this.ctx;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    if (!elevated) {
      for (const s of segs) {
        const c = this.cache.get(s.id)!;
        const parts = c.minLevel < -0.4 ? this.splitBy(c, (h) => h >= -0.4) : [c.surface];
        const passes: [string, number][] = c.wet
          ? [
              [C.rail, c.width + 6],
              [C.deck, c.width + 2],
            ]
          : [
              ['#9c948a', c.width + 1.5],
              ['#b9b1a6', c.width - 1],
            ];
        for (const [color, width] of passes) {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          for (const part of parts) {
            this.polyline(part);
            ctx.stroke();
          }
        }
      }
    }
    if (this.camera.zoom < 0.45) return;
    ctx.strokeStyle = '#7a5a3c';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const s of segs) {
      const sl = this.cache.get(s.id)!.rail.sleepers;
      for (let i = 0; i + 1 < sl.length; i += 2) {
        ctx.moveTo(sl[i].x, sl[i].y);
        ctx.lineTo(sl[i + 1].x, sl[i + 1].y);
      }
    }
    ctx.stroke();
  }

  /** Сами рельсы — поверх асфальта, чтобы на переезде было видно путь. */
  private drawRailSteel(segs: Segment[]): void {
    if (!segs.length) return;
    const ctx = this.ctx;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = '#4f5965';
    ctx.lineWidth = Math.max(1.1, 0.8 / this.camera.zoom);
    ctx.beginPath();
    for (const s of segs) {
      for (const r of this.cache.get(s.id)!.rail.rails) r.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    }
    ctx.stroke();
  }

  /**
   * Ж/д сигналы: столбик справа по ходу поезда. Зелёный — блок за сигналом свободен,
   * красный — там поезд или бронь.
   */
  private drawSignals(game: Game, view: ReturnType<Renderer['view']>): void {
    if (this.camera.zoom < 0.3) return;
    const net = game.net;
    for (const n of net.nodes.values()) {
      if (!n.signals?.length) continue;
      if (n.pos.x < view.x0 || n.pos.x > view.x1 || n.pos.y < view.y0 || n.pos.y > view.y1) continue;
      for (const out of n.signals) {
        if (!net.segments.has(out)) continue;
        const d = net.dirFrom(n.id, out);
        this.signalPost(add(n.pos, scale({ x: -d.y, y: d.x }, RAIL_HALF + 4)), d, game.rail.isReserved(out) ? '#e8483f' : '#3ad16b', !!n.oneWay?.includes(out));
      }
    }
  }

  /** oneWay — сигнал без встречного: с обратной стороны знак «въезд запрещён» (красный круг с белой чертой). */
  private signalPost(p: Vec, d: Vec, light: string, oneWay = false): void {
    const ctx = this.ctx;
    if (oneWay) {
      const q = add(p, scale(d, 4.4));
      ctx.fillStyle = '#d93a32';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(q.x - d.y * 1.6, q.y + d.x * 1.6);
      ctx.lineTo(q.x + d.y * 1.6, q.y - d.x * 1.6);
      ctx.stroke();
    }
    // Стойка поперёк пути и голова сигнала, смотрящая навстречу поезду.
    ctx.strokeStyle = '#2a2e33';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + d.y * 3, p.y - d.x * 3);
    ctx.stroke();
    ctx.fillStyle = '#2a2e33';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Переезды: шлагбаумы и мигающие красные огни, пока подходит поезд. */
  private drawCrossings(game: Game, view: ReturnType<Renderer['view']>): void {
    if (this.camera.zoom < 0.4) return;
    const ctx = this.ctx;
    const net = game.roads.net;
    const blink = Math.floor(performance.now() / 400) % 2 === 0;
    for (const x of game.levelCrossings) {
      if (x.pos.x < view.x0 || x.pos.x > view.x1 || x.pos.y < view.y0 || x.pos.y > view.y1) continue;
      const c = net.corridors.get(x.corridor);
      if (!c) continue;
      // Огни закрытого переезда мигают — и на паузе.
      if (x.closed) this.ambient = true;
      // Два въезда на переезд — с каждой стороны пути; у каждого справа столбик, при поезде — шлагбаум.
      for (const side of [-1, 1]) {
        const cs = Math.max(0, Math.min(c.length, x.s + side * (RAIL_HALF + 4)));
        const p = c.lut.pointAt(cs);
        const along = c.lut.tangentAt(cs);
        const t = scale(along, -side);
        const N = { x: -t.y, y: t.x };
        const e = edgesAt(c, cs) ?? [-LANE_W, LANE_W];
        const half = side < 0 ? e[1] : -e[0];
        const post = add(p, scale(N, half + 2));
        if (x.closed) {
          // Шлагбаум перекрывает въезд на переезд: красно-белая планка.
          const tip = add(p, scale(N, -1));
          ctx.lineCap = 'round';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.moveTo(post.x, post.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          ctx.strokeStyle = '#e8483f';
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(post.x, post.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.fillStyle = '#2a2e33';
        ctx.beginPath();
        ctx.arc(post.x, post.y, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = x.closed && blink ? '#ff4a3d' : '#5a2a28';
        ctx.beginPath();
        ctx.arc(post.x, post.y, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * Стоп-линии — сплошные, поперёк всех полос подъезда к перекрёстку. pass — слой высоты подъезда: спуск с моста
   * к перекрёстку рисуется слоем моста — его стоп-линия там же, поверх полотна (с земли её закрыло бы полотно).
   * preview — предпросмотр правки: у перекрёстков, что она меняет, стоп-линии — по сети с правкой (едут за протяжкой).
   */
  private drawStopLines(game: Game, view: ReturnType<Renderer['view']>, pass: number, preview: JunctionPreview | null = null): void {
    if (this.camera.zoom < 0.6) return;
    this.stopLinesOf(game.roads.graph, view, pass, (id) => !previewHides(preview, id));
    if (preview?.graph) this.stopLinesOf(preview.graph, view, pass, (id) => preview.nodes.has(id));
    this.ctx.setLineDash([]);
  }

  /** Стоп-линии перекрёстков графа g, которые keep пропускает. */
  private stopLinesOf(g: LaneGraph, view: ReturnType<Renderer['view']>, pass: number, keep: (id: number) => boolean): void {
    const ctx = this.ctx;
    const net = g.net;
    for (const n of g.nodes.values()) {
      // Стоп-линии — на всех подъездах перекрёстка (и на главной дороге); на кольце — только на въездах.
      const node = net.nodes.get(n.id);
      if (!node || node.kind !== 'junction' || node.corridors.length < 3 || !keep(n.id)) continue;
      if (n.pos.x < view.x0 || n.pos.x > view.x1 || n.pos.y < view.y0 || n.pos.y > view.y1) continue;
      const ring = (node.roundabout ?? null) !== null;
      for (const link of g.inLinks.get(n.id) ?? []) {
        const c = net.corridors.get(link.corridor);
        // На грунтовке разметки нет — и стоп-линии тоже (и у самой улицы со стороны просёлка).
        if (!c || isDirt(c.cls) || (ring && c.ring) || !inPass(corridorLayer(net, c), pass)) continue;
        // Одной чертой поперёк всех полос подъезда (без щелей между полосами), чуть отступив от перекрёстка.
        const first = link.lanes[0];
        const last = link.lanes[link.lanes.length - 1];
        if (!first || !last) continue;
        // Перед пешеходным переходом — дальше от перекрёстка, на зебру (LaneGraph.stopBack).
        const u = Math.max(0, first.length - STOP_LINE_BACK - (g.stopBack.get(first.id) ?? 0));
        const l = g.lanePose(first, u);
        const r = g.lanePose(last, u);
        const d = deckLift(net, c, g.axisS(first, u));
        const a = add(add(l.pos, scale(rightNormal(l.dir), -LANE_W / 2 + STOP_LINE_INSET)), d);
        const b = add(add(r.pos, scale(rightNormal(r.dir), LANE_W / 2)), d);
        // Белая без прозрачности: стоп-линия заметнее разметки полос.
        ctx.strokeStyle = '#f2f1ea';
        ctx.lineWidth = STOP_LINE_W;
        ctx.lineCap = 'butt';
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  /**
   * Тротуары на карте при сети net (с правкой в предпросмотре или сама сеть игры): без правки — по сети игры
   * (walkBase), с правкой — только затронутые ею (sidewalkScope) заново по сети с правкой, остальные — прежние. Раз на
   * версию сети с правкой.
   */
  private liveSidewalks(game: Game, net: LaneNet): SidewalkNet {
    const base = this.walkBase;
    if (net === game.roads.net) {
      this.walkLive = null;
      return base;
    }
    const c = this.walkLive;
    if (c && c.net === net && c.version === net.version && c.base === base) return c.shown;
    const scope = sidewalkScope(game.roads.net, net);
    const shown = scope ? mergeSidewalks(base, sidewalkNet(net, this.liveSite(game, base), this.sidewalkCache, scope), scope) : base;
    this.walkLive = { net, version: net.version, base, shown };
    return shown;
  }

  /**
   * Аллеи на карте при сети net: без правки — по сети игры (alleys.lines), с правкой — аллеи полотен, что правка может
   * задеть (alleyScope), заново по сети с правкой, остальные — прежние. Раз на версию сети с правкой.
   */
  private liveAlleys(game: Game, net: LaneNet): StreetGreen[] {
    const a = this.alleys;
    if (net === game.roads.net) {
      a.live = null;
      return a.lines;
    }
    const c = a.live;
    if (c && c.net === net && c.version === net.version && c.base === a.lines) return a.shown;
    a.live = { net, version: net.version, base: a.lines };
    const scope = sidewalkScope(game.roads.net, net);
    if (!scope) return a.lines;
    const touched = alleyScope(game.roads.net, net, scope);
    const index = game.index;
    const part = streetGreen(net, a.towns, (p, r) => index.at(p, r) !== null || this.drivewayOccupied(p, r * 1.1), a.cache, touched);
    return [...a.lines.filter((l) => !touched.has(l.id) && net.corridors.has(l.id)), ...part];
  }

  /**
   * Где тротуары (walkSite) для протяжки: строения вокруг полотна — с запоминанием, пока тротуары без правки те же (их
   * пересчитывают и стройка, и рост городов): у полотен, что правка не трогала, запрос к индексу — раз на протяжку.
   */
  private liveSite(game: Game, base: SidewalkNet): WalkSite {
    const had = this.walkSite;
    if (had && had.base === base && had.game === game && had.memo.size < 4000) return had.site;
    const raw = walkSite(game);
    const memo = new Map<string, Around>();
    const site: WalkSite = {
      ...raw,
      around: (p, r) => {
        const k = `${p.x},${p.y},${r}`;
        let a = memo.get(k);
        if (!a) memo.set(k, (a = raw.around(p, r)));
        return a;
      },
    };
    this.walkSite = { game, base, memo, site };
    return site;
  }

  /** Предпросмотр сети net (с правкой) поверх сети игры base — один раз на её версию: перекрёстки, что правка меняет. */
  private junctionPreview(base: LaneNet, net: LaneNet): JunctionPreview | null {
    const c = this.previewOf;
    if (c && c.net === net && c.version === net.version && c.base === base && c.baseVersion === base.version) return c.preview;
    const preview = junctionPreview(base, net, () => this.lanes.cutsOf(net));
    this.previewOf = { net, version: net.version, base, baseVersion: base.version, preview };
    return preview;
  }

  /**
   * Карта пробок: каждая связь графа движения — цветом загрузки (зелёный — свободно, красный — стоят). pass — слой
   * высоты, как у карты скоростей: мосты, эстакады и съезды на них — в своём слое, поверх полотна и поднятые с ним.
   */
  /** Клетки слоя «🅿️» — считаются раз в секунду игры (game.parkingLayer обходит все места). */
  private parkCells: { at: number; game: Game; cells: ParkingCell[] } | null = null;

  /**
   * Слой «🅿️» (game/parkingLayer.ts): клетки ≈ 100 м, где есть места для машин — дворы, гаражные боксы, стоянки
   * магазинов, — цветом занятости: зелёный — меньше 70 %, жёлтый — 70–90 %, красный — больше 90 %. Посередине — значок
   * «P» того же цвета, ближе — сколько мест занято из скольких.
   */
  private drawParkmap(game: Game, view: ReturnType<Renderer['view']>): void {
    const now = Math.floor(game.time);
    if (!this.parkCells || this.parkCells.game !== game || this.parkCells.at !== now) this.parkCells = { at: now, game, cells: game.parkingLayer() };
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const COLORS: Record<ParkingLevel, string> = { free: '46,170,90', busy: '230,180,40', full: '220,60,50' };
    for (const c of this.parkCells.cells) {
      if (c.x > view.x1 || c.x + c.size < view.x0 || c.y > view.y1 || c.y + c.size < view.y0) continue;
      const rgb = COLORS[parkingLevel(c)];
      ctx.fillStyle = `rgba(${rgb},0.26)`;
      ctx.fillRect(c.x, c.y, c.size, c.size);
      ctx.strokeStyle = `rgba(${rgb},0.75)`;
      ctx.lineWidth = 1.5 / z;
      ctx.strokeRect(c.x + 0.75 / z, c.y + 0.75 / z, c.size - 1.5 / z, c.size - 1.5 / z);
      // Кружат в поисках места — косая штриховка красным.
      if (c.circling) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(c.x, c.y, c.size, c.size);
        ctx.clip();
        ctx.strokeStyle = 'rgba(220,60,50,0.55)';
        ctx.lineWidth = 3 / z;
        ctx.beginPath();
        const step = 18 / z;
        for (let d = -c.size; d < c.size; d += step) {
          ctx.moveTo(c.x + d, c.y);
          ctx.lineTo(c.x + d + c.size, c.y + c.size);
        }
        ctx.stroke();
        ctx.restore();
      }
      const cx = c.x + c.size / 2;
      const cy = c.y + c.size / 2;
      const r = 9 / z;
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${12 / z}px system-ui, sans-serif`;
      ctx.fillText('P', cx, cy + 0.5 / z);
      if (c.size * z < 90) continue;
      ctx.font = `${11 / z}px system-ui, sans-serif`;
      ctx.lineWidth = 3 / z;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      const text = `${c.used}/${c.total}`;
      ctx.strokeText(text, cx, cy + r + 8 / z);
      ctx.fillStyle = '#333';
      ctx.fillText(text, cx, cy + r + 8 / z);
    }
  }

  private drawHeatmap(game: Game, pass: number): void {
    const ctx = this.ctx;
    const g = game.roads.graph;
    const view = this.view();
    ctx.lineCap = 'round';
    for (const link of g.links.values()) {
      const c = g.net.corridors.get(link.corridor);
      if (!c || !link.lanes.length || !inPass(corridorLayer(g.net, c), pass)) continue;
      const mid = c.lut.pointAt((link.s0 + link.s1) / 2);
      if (mid.x < view.x0 - link.length || mid.x > view.x1 + link.length || mid.y < view.y0 - link.length || mid.y > view.y1 + link.length) continue;
      let count = 0;
      let stopped = 0;
      for (const lane of link.lanes) {
        count += lane.vehicles.length;
        for (const v of lane.vehicles) if (v.v < 3) stopped++;
      }
      const density = Math.min(1, (count * 9) / Math.max(10, link.length * link.lanes.length));
      const load = Math.min(1, density * 0.7 + (count ? (stopped / count) * density : 0));
      const off = link.lanes.reduce((a, l) => a + l.offset, 0) / link.lanes.length;
      ctx.strokeStyle = `hsla(${120 - load * 120}, 80%, 46%, 0.8)`;
      ctx.lineWidth = Math.max(2.5, link.lanes.length * 2.5);
      this.polyline(deckLine(g.net, c, link.s0, link.s1, off, 6));
      ctx.stroke();
    }
  }

  /**
   * Карта скоростей: каждая связь — цветом разрешённой скорости, на поворотах — сниженной изгибом. Обычно — одной
   * линией посередине полос; где полосы расходятся (отгон, развилка, вливание) — каждая полоса своей (speedStrokes).
   * pass — слой высоты: на земле — дороги земли и тоннелей, на мостах и эстакадах — их, поверх полотна и поднятые с ним.
   */
  private drawSpeedmap(game: Game, pass: number, view: Box): void {
    const ctx = this.ctx;
    const g = game.roads.graph;
    ctx.save();
    ctx.lineCap = 'butt';
    for (const link of g.links.values()) {
      const c = g.net.corridors.get(link.corridor);
      if (!c || !link.lanes.length || !inPass(corridorLayer(g.net, c), pass)) continue;
      const mid = c.lut.pointAt((link.s0 + link.s1) / 2);
      if (mid.x < view.x0 - link.length || mid.x > view.x1 + link.length || mid.y < view.y0 - link.length || mid.y > view.y1 + link.length) continue;
      for (const stroke of speedStrokes(g, link)) {
        const lane = stroke.lanes[0];
        const prof = game.traffic.profile(lane);
        ctx.lineWidth = stroke.width;
        const kmhAt = (k: number) => Math.min(lane.speed, prof.c[k]) * KMH_PER_UNIT;
        const push = (pts: Vec[], u: number) => {
          const p = strokePoint(g.net, c, stroke, g.axisS(lane, u));
          if (p) pts.push(p);
        };
        let k0 = 0;
        for (let k = 1; k <= prof.c.length; k++) {
          if (k < prof.c.length && speedColor(kmhAt(k)) === speedColor(kmhAt(k0))) continue;
          const u0 = Math.min(lane.length, k0 * PROFILE_STEP);
          const u1 = Math.min(lane.length, k * PROFILE_STEP);
          if (u1 > u0) {
            const pts: Vec[] = [];
            for (let u = u0; u < u1; u += 3) push(pts, u);
            push(pts, u1);
            ctx.strokeStyle = speedColor(kmhAt(k0));
            this.polyline(pts);
            ctx.stroke();
          }
          k0 = k;
        }
      }
    }
    ctx.restore();
  }

  /**
   * Карта скоростей на ж/д путях: каждый участок — по оси между рельсами цветом допустимой скорости поезда (та же шкала,
   * что у дорог: путь — до 120 км/ч, изгиб снижает). Участки — уже своего слоя высоты (на мосту — поднятые с настилом).
   */
  private drawRailSpeedmap(segs: Segment[]): void {
    if (!segs.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    for (const s of segs) {
      const c = this.cache.get(s.id)!;
      // Издалека — шире, до полотна пути: иначе тонкую линию между рельсами не разглядеть.
      ctx.lineWidth = Math.min(c.width, Math.max(RAIL_SPEEDMAP_W, 3.5 / this.camera.zoom));
      ctx.strokeStyle = speedColor(trackKmhExact(s));
      this.polyline(c.surface);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Легенда карты скоростей — в углу экрана. */
  private drawSpeedLegend(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.camera.dpr, 0, 0, this.camera.dpr, 0, 0);
    const x = 16;
    const y = 88;
    const items = SPEED_STEPS;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.beginPath();
    ctx.roundRect(x, y, 14 + items.length * 34, 34, 8);
    ctx.fill();
    ctx.font = '600 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    items.forEach(([kmh, color], i) => {
      const cx = x + 24 + i * 34;
      ctx.fillStyle = color;
      ctx.fillRect(cx - 13, y + 8, 26, 6);
      ctx.fillStyle = '#2b2f36';
      ctx.fillText(String(kmh), cx, y + 24);
    });
    ctx.restore();
  }

  /**
   * Знаки ограничения скорости перед поворотами, которые снижают скорость: по обе стороны дороги в начале
   * изгиба, для каждого направления — по ходу движения (как на настоящих дорогах). pass — слой высоты, как у карты скоростей.
   */
  private drawCurveSigns(game: Game, view: ReturnType<Renderer['view']>, stale: Set<number> | null | undefined, pass: number): void {
    const z = this.camera.zoom;
    if (z < 0.45) return;
    const ctx = this.ctx;
    const g = game.roads.graph;
    const r = Math.max(3.2, 9 / z);
    ctx.save();
    this.signText(r);
    for (const link of g.links.values()) {
      const c = g.net.corridors.get(link.corridor);
      if (!c || !link.lanes.length || c.ring || !inPass(corridorLayer(g.net, c), pass)) continue;
      const mid = c.lut.pointAt((link.s0 + link.s1) / 2);
      if (mid.x < view.x0 - link.length || mid.x > view.x1 + link.length || mid.y < view.y0 - link.length || mid.y > view.y1 + link.length) continue;
      const right = link.lanes[link.lanes.length - 1];
      const left = link.lanes[0];
      const zones = curveZones(game.traffic.profile(right), right.speed, KMH_PER_UNIT);
      for (const zone of zones) {
        // Знак — чуть раньше начала изгиба, по ходу движения.
        const u = Math.max(0, zone.from - 15);
        // Слева — только там, где встречки рядом нет (односторонняя, магистраль с барьером).
        const sides = c.cls === 'motorway' || c.lanes.every((l) => l.flow === link.flow) ? ([[right, 1], [left, -1]] as const) : ([[right, 1]] as const);
        for (const [lane, side] of sides) {
          // У кромки полосы (на отгоне — у настоящей); у развилки, где сбоку чужая дорога, — дальше, где есть место.
          const p = signSpot(g, lane, u, side, r, zone.to);
          // Полотно в проекте меняется — его знаки старые: бледно (новые — в стиле проекта); тянут его в «Двигать» —
          // прежних знаков нет совсем, их место заняли знаки дороги в новой форме (liveSigns).
          if (p && !this.hiddenSigns?.has(c.id)) this.limitSign(p, r, zone.kmh, stale?.has(c.id) ? 'stale' : 'road');
        }
      }
    }
    ctx.restore();
  }

  /**
   * Знак ограничения скорости радиуса r (мир) в точке p: у построенной дороги — красный; stale — бледный (полотно
   * в проекте уйдёт или поменяет форму); project — знак проекта: синий пунктир по ободу, полупрозрачный, как сам проект.
   */
  private limitSign(p: Vec, r: number, kmh: number, style: 'road' | 'stale' | 'project' = 'road'): void {
    // Шрифт и выравнивание числа — раз на все знаки (signText), без save/restore на каждый.
    const ctx = this.ctx;
    const alpha = ctx.globalAlpha;
    if (style === 'stale') ctx.globalAlpha = alpha * 0.3;
    ctx.fillStyle = style === 'project' ? 'rgba(231,240,253,0.9)' : '#fff';
    ctx.strokeStyle = style === 'project' ? '#2f80ed' : '#d93a30';
    ctx.lineWidth = r * (style === 'project' ? 0.24 : 0.28);
    if (style === 'project') ctx.setLineDash([r * 0.55, r * 0.35]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (style === 'project') ctx.setLineDash([]);
    ctx.fillStyle = style === 'project' ? '#1f5fbf' : '#1d2026';
    ctx.fillText(String(kmh), p.x, p.y + r * 0.05);
    ctx.globalAlpha = alpha;
  }

  /** Знаки скорости радиуса r: шрифт и выравнивание числа на них — раз на все (limitSign их не ставит). */
  private signText(r: number): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${r * 0.95}px sans-serif`;
  }

  /**
   * Светофоры: у стоп-линии справа от крайней правой полосы каждого въезда — корпус с тремя секциями вдоль бордюра
   * и колонка за ним (src/render/trafficLightArt.ts). Основная секция — по фазе (зелёный, жёлтый, красный); рядом,
   * дальше от дороги, — дополнительные со стрелкой, если у поворота есть своя фаза: стрелка горит, когда поворот
   * разрешён по ней (src/lanes/lights.ts, signalHeads). pass — слой высоты: светофор рисуется в слое своего подъезда
   * и поднят вместе с его полотном (спуск с моста, эстакада — src/lanes/lightSpot.ts); 'covered' — те, что сверху
   * закрыл чужой мост, ещё раз поверх всего, приглушённо. show — фазу, которую правят на карте: светофоры её
   * перекрёстка горят так, как в ней.
   */
  private drawLights(game: Game, view: Box, pass: number | 'covered', show?: { node: number; i: number } | null): void {
    const z = this.camera.zoom;
    if (z < 0.4) return;
    const ctx = this.ctx;
    const g = game.roads.graph;
    // Где светофоры (слой подъезда, подъём с полотном, закрыт ли мостом сверху) — раз на граф движения.
    if (this.lightSpots?.graph !== g) this.lightSpots = { graph: g, spots: new Map() };
    const spots = this.lightSpots.spots;
    const k = lightScale(z);
    const detail = z >= 1;
    const pad = 12 * k;
    // Каждый светофор — setFrame поверх преобразования мира; после всех — оно же и прежняя прозрачность.
    const m = ctx.getTransform();
    const base: Frame = { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
    const alpha = ctx.globalAlpha;
    // Закрытые сверху (перекрёсток под мостом) — ещё раз поверх всего, приглушённо: как значок.
    if (pass === 'covered') ctx.globalAlpha = alpha * 0.55;
    let drawn = false;
    const look: LightLook = { pos: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, main: 'red', arrows: [] };
    const arrows: { dir: Vec; lamp: Lamp | null }[] = [];
    for (const n of g.nodes.values()) {
      const L = n.lights;
      if (!L) continue;
      if (n.pos.x < view.x0 - 80 || n.pos.x > view.x1 + 80 || n.pos.y < view.y0 - 80 || n.pos.y > view.y1 + 80) continue;
      const shown = show?.node === n.id && show.i < L.phases.length;
      const phase = shown ? show.i : L.phase;
      const amber = L.clearing && !shown;
      for (const head of L.heads) {
        const link = g.links.get(head.link);
        if (!link) continue;
        if (!spots.has(head.link)) spots.set(head.link, lightSpot(g, link, head.arrows.length));
        const spot = spots.get(head.link);
        if (!spot || (pass === 'covered' ? !spot.covered : !inPass(spot.layer, pass))) continue;
        const p = spot.pos;
        if (p.x < view.x0 - pad || p.x > view.x1 + pad || p.y < view.y0 - pad || p.y > view.y1 + pad) continue;
        arrows.length = 0;
        for (const a of head.arrows) arrows.push({ dir: a.dir, lamp: a.on[phase] ? lampOf(true, amber) : null });
        look.pos = p;
        look.dir = spot.dir;
        look.main = lampOf(head.main[phase], amber);
        look.arrows = arrows;
        drawTrafficLight(ctx, base, look, k, detail);
        drawn = true;
      }
    }
    if (drawn) resetFrame(ctx, base);
    ctx.globalAlpha = alpha;
  }

  // ---------- Машины ----------

  /**
   * Машины у гаражей частных домов (game/garages.ts): вблизи (как машины во дворах, FINE_ZOOM) — стоящие перед
   * воротами, и всегда — на манёвре во дворе. Проезжая в ворота, машина видна только до них (дальше — под крышей
   * гаража), а ворота открыты — тёмный проём.
   */
  private drawGarageCars(game: Game, view: Box): void {
    const ctx = this.ctx;
    // Границы мест на полосах стоянки (game/curbParking.ts) — под машинами, когда разметка уже читается.
    if (this.camera.zoom >= 0.6) {
      const marks = game.curbMarks([view.x0, view.y0, view.x1, view.y1]);
      if (marks.length) {
        ctx.strokeStyle = 'rgba(245, 243, 230, 0.85)';
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        for (const [a, b] of marks) {
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }
    }
    const list = game.garageLooks([view.x0, view.y0, view.x1, view.y1], this.camera.zoom >= FINE_ZOOM);
    for (const { look, gate, hidden } of list) {
      if (hidden) continue;
      if (!gate) {
        this.drawVehicles([look]);
        continue;
      }
      const side = scale(rightNormal(gate.dir), gate.width / 2);
      const deep = scale(gate.dir, 1.2);
      ctx.fillStyle = 'rgba(36,38,44,0.92)';
      this.polyline([add(gate.pos, side), sub(gate.pos, side), add(sub(gate.pos, side), deep), add(add(gate.pos, side), deep)]);
      ctx.closePath();
      ctx.fill();
      const far = scale(rightNormal(gate.dir), 40);
      const back = scale(gate.dir, -40);
      this.drawClipped([add(gate.pos, far), sub(gate.pos, far), add(sub(gate.pos, far), back), add(add(gate.pos, far), back)], () => this.drawVehicles([look]));
    }
  }

  /**
   * halo — белая обводка, чтобы машины линии читались поверх её маршрута; lifted — машины на мосту: подняты вместе с
   * полотном под ними (Vehicle.lift — из движения).
   */
  private drawVehicles(list: readonly (VehicleLook & { lift?: number })[], halo = false, lifted = false): void {
    if (!list.length) return;
    const ctx = this.ctx;
    const detailed = this.camera.zoom > 0.5;
    const ring = halo ? Math.max(1.2, 1.6 / this.camera.zoom) : 0;
    // Издали мигалки бледнее и меньше, а совсем издали не горят вовсе.
    const siren = sirenVisibility(this.camera.zoom);
    const flash = siren > 0 ? this.flash : undefined;
    // Части кузова и поворотники — setTransform поверх преобразования холста (base), без save/restore на каждую;
    // стиль холста после всех машин — прежний.
    const m = ctx.getTransform();
    const base: Frame = { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
    const up: Frame = { ...base };
    const o: VehicleDrawOptions = { detailed, halo: ring, flash, frame: base };
    ctx.save();
    for (const v of list) {
      // На мосту — поднята вместе с полотном: всё, что у машины, — сдвинутым на подъём холстом.
      const lift = lifted ? (v.lift ?? 0) : 0;
      const frame = lift ? up : base;
      if (lift) {
        up.e = base.e + base.c * lift;
        up.f = base.f + base.d * lift;
        resetFrame(ctx, up);
      }
      o.frame = frame;
      // Кузов по модели (фургон, тягач с полуприцепом, автобусы), у машин из двух частей — с изгибом в шарнире.
      drawVehicleArt(ctx, v, o);
      if (v.siren && siren > 0) this.drawSirenGlow(v, siren);
      if (v.blinker && this.blinkOn && v.width * this.camera.zoom >= BLINKER_MIN_PX) {
        // Поворотники — на первой части кузова (у тягача, у передней секции).
        const l = Math.hypot(v.dir.x, v.dir.y);
        setFrame(ctx, frame, v.pos.x, v.pos.y, l > 0 ? v.dir.x / l : 1, l > 0 ? v.dir.y / l : 0);
        this.drawBlinker(frontLength(v), v.width, v.blinker);
        resetFrame(ctx, frame);
      }
      if (lift) resetFrame(ctx, base);
    }
    ctx.restore();
  }

  /**
   * Ореол горящей половины мигалки спецмашины — поверх кузова, не меньше SIREN_GLOW_PX на экране; издали (seen < 1,
   * sirenVisibility) — бледнее и меньше.
   */
  private drawSirenGlow(v: VehicleLook, seen: number): void {
    const spot = flashSpot(v, this.flash);
    if (!spot) return;
    const ctx = this.ctx;
    const r = Math.max(v.width * 1.5, (SIREN_GLOW_PX * seen) / this.camera.zoom);
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * seen;
    const x = v.pos.x + v.dir.x * spot.x - v.dir.y * spot.y;
    const y = v.pos.y + v.dir.y * spot.x + v.dir.x * spot.y;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, spot.color + 'ee');
    glow.addColorStop(0.35, spot.color + '88');
    glow.addColorStop(1, spot.color + '00');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
  }

  /** Огоньки поворотника на углах кузова со стороны поворота: спереди, а с BLINK_REAR и сзади (в системе машины: нос в 0, справа +y). */
  private drawBlinker(L: number, W: number, side: number): void {
    const ctx = this.ctx;
    const r = Math.min(W * 0.2, Math.max(0.6, 1.1 / this.camera.zoom));
    const y = side * (W / 2 - r * 0.6);
    for (const x of BLINK_REAR ? [-r * 0.9, -L + r * 0.9] : [-r * 0.9]) {
      ctx.fillStyle = 'rgba(255, 166, 0, 0.38)';
      ctx.beginPath();
      ctx.arc(x, y, r * 2.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffc21a';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------- Строения ----------

  private haulRoadCache = { game: null as Game | null, revision: '', list: [] as { st: Station; ind: Industry; path: readonly Vec[]; box: Box }[] };

  private haulRoads(game: Game): typeof this.haulRoadCache.list {
    const cache = this.haulRoadCache;
    const revision = game.industryHaulRevision;
    if (cache.game === game && cache.revision === revision) return cache.list;
    cache.game = game;
    cache.revision = revision;
    cache.list = [];
    for (const st of game.stations.values()) {
      if (st.kind !== 'road' || st.curb || st.industryId === null) continue;
      const ind = game.industries.find((i) => i.id === st.industryId);
      if (!ind) continue;
      const path = game.industryHaulRoad(st, ind);
      if (!path?.length) continue;
      const xs = path.map((p) => p.x);
      const ys = path.map((p) => p.y);
      const box = grow({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }, LANE_W * 2);
      cache.list.push({ st, ind, path, box });
    }
    return cache.list;
  }

  /** Дома городов, предприятия и пристройки — без движущегося (оно — drawMotion, поверх). */
  private drawStill(game: Game, view: Box): void {
    const inView = (fp: Footprint) =>
      fp.center.x > view.x0 - 100 && fp.center.x < view.x1 + 100 && fp.center.y > view.y0 - 100 && fp.center.y < view.y1 + 100;
    // Дома в зоне вредных предприятий — с посеревшими крышами (enterpriseArt.houseGrime → houseArt.grimy).
    const dirty = dirtyIndustries(game.industries);
    const trees = BIOMES[game.terrain.biome].palette.trees;
    for (const town of game.towns) {
      if (dist(town.center, { x: (view.x0 + view.x1) / 2, y: (view.y0 + view.y1) / 2 }) > (town.extent ?? town.radius) + (view.x1 - view.x0) * 1.2) continue;
      const driveColors = this.walks.get(town.id)?.driveColors;
      for (const b of town.buildings) {
        if (!inView(b.fp)) continue;
        // Тип застройки — двор, забор, огород, панельный дом с площадкой… (houseArt; детали — по зуму).
        const grime = dirty.length && b.kind !== 'landmark' ? houseGrime(b, dirty) : 0;
        drawHouseArt(this.ctx, b, this.camera.zoom, trees, grime, driveColors?.get(b.id));
      }
    }
    for (const ind of game.industries) {
      const annexes = (ind.annexes ?? []).filter((a) => inView(a.fp));
      const roads = annexes.flatMap((a) => {
        const path = a.connector ?? (a.access ? [a.access, a.fp.center] : undefined);
        return path ? [path.map(({ x, y }) => [x, y] as const)] : [];
      });
      if (roads.length) drawIndustrialRoads(this.ctx, roads, industryRoadSurface(ind.info.kind));
      // Пристройка — своё вспомогательное здание предприятия (annexArt).
      for (const a of annexes) if (!a.roadOnly) this.drawAnnex(ind, a, 'still');
      if (seenAt(ind.fp.center, view, Math.max(100, footprintRadius(ind.fp) + 30))) this.drawIndustry(ind, 'still');
    }
  }

  /** Парки, скверы, сквер с памятником и набережная городов (parkArt) — в плитки кэша, под дорогами. */
  private drawParks(game: Game, view: Box): void {
    const trees = BIOMES[game.terrain.biome].palette.trees;
    for (const town of game.towns) {
      for (const p of town.parks ?? []) {
        const r = Math.hypot(p.fp.w, p.fp.h) / 2 + PARK_REACH;
        if (p.fp.center.x + r < view.x0 || p.fp.center.x - r > view.x1 || p.fp.center.y + r < view.y0 || p.fp.center.y - r > view.y1) continue;
        drawParkArt(this.ctx, p, this.camera.zoom, trees);
      }
    }
    // Площадки-стоянки — тоже под дорогами; большая с тупиком-выездом — поверх сети (drawLots после неё).
    this.drawLots(game, view, false);
  }

  /**
   * Площадки-стоянки: over — большие с тупиком-выездом (после сети: он виден до края площадки, а на ней — проезд её
   * покрытием, без кромки и разметки дороги), иначе — прочие (под сетью).
   */
  private drawLots(game: Game, view: Box, over: boolean): void {
    for (const town of game.towns) {
      for (const l of town.lots ?? []) {
        if (l.removed || !!l.nodes?.length !== over) continue;
        const r = Math.hypot(l.fp.w, l.fp.h) / 2 + LOT_REACH;
        if (l.fp.center.x + r < view.x0 || l.fp.center.x - r > view.x1 || l.fp.center.y + r < view.y0 || l.fp.center.y - r > view.y1) continue;
        drawLotArt(this.ctx, l, this.camera.zoom);
      }
    }
  }

  /** Месторождения и копоть земли у вредных предприятий — в плитки кэша (режим «Строит игрок»). */
  private drawEnterpriseGround(game: Game, view: Box): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const seen = (p: Vec, r: number) => p.x > view.x0 - r && p.x < view.x1 + r && p.y > view.y0 - r && p.y < view.y1 + r;
    for (const ind of game.industries) if (seen(ind.fp.center, 300)) drawSoot(ctx, ind);
    for (const d of game.enterprises.deposits) if (seen(d.center, 120)) drawDeposit(ctx, d, z);
  }

  /**
   * Движущееся у предприятий и пристроек — дым, мерцание огня, качалки (только вблизи), — в каждом кадре: только их
   * излучатели (industryMotion), записанные раз; предприятия без движущегося в кадре не трогаются. Фонтаны — так же.
   */
  private drawMotion(game: Game, view: Box): void {
    const z = this.camera.zoom;
    if (!artMoves(z)) return;
    const inView = (fp: Footprint) => seenAt(fp.center, view, Math.max(100, footprintRadius(fp) + 30));
    const time = performance.now() / 1000;
    // Фонтаны у ратуш и в парках — рябь на воде, только при сильном приближении (дёшево: пара дуг на фонтан).
    if (z > FOUNTAIN_ZOOM) {
      const seen = (p: { x: number; y: number }) => p.x > view.x0 - 10 && p.x < view.x1 + 10 && p.y > view.y0 - 10 && p.y < view.y1 + 10;
      const list = this.fountainsOf(game).filter(seen);
      if (list.length) {
        drawFountainRipples(this.ctx, list, time);
        this.ambient = true;
      }
    }
    // Дым, огонь и качалки движутся и на паузе (по часам, а не по времени игры).
    // Фон: кадры для него — реже (AMBIENT_FPS, src/render/redraw.ts).
    const ctx = this.ctx;
    let base: DOMMatrix | null = null;
    for (const it of this.emittersOf(game)) {
      if (!inView(it.fp)) continue;
      if (!base) {
        base = ctx.getTransform();
        ctx.save();
      }
      drawEmitters(ctx, it.list, time, base);
      this.ambient = true;
    }
    if (base) ctx.restore();
  }

  /** Излучатели предприятий и пристроек (с движущимся) — пересчёт после правки предприятий (Game.industryRev). */
  private emitting = { game: null as Game | null, rev: -1, list: [] as { fp: Footprint; list: Emitter[] }[] };
  /** Излучатели меняются при правке участка, работы или количества скота у мясокомбината. */
  private motionOf = new WeakMap<object, { fp: Footprint; level: number; active: boolean; annexes: unknown; livestock: number; list: Emitter[] }>();

  private emittersOf(game: Game): { fp: Footprint; list: Emitter[] }[] {
    const m = this.emitting;
    if (m.game === game && m.rev === game.industryRev) return m.list;
    m.game = game;
    m.rev = game.industryRev;
    m.list = [];
    const take = (key: Industry | Annex, ind: Industry, make: () => Emitter[]) => {
      const level = Math.max(1, Math.floor(ind.level ?? 1));
      const active = ind.producedMonth > 0 || ind.producedLast > 0;
      const livestock = key === ind && ind.info.kind === 'meatplant' ? ind.stock.livestock ?? 0 : 0;
      let had = this.motionOf.get(key);
      if (!had || had.fp !== key.fp || had.level !== level || had.active !== active || had.annexes !== ind.annexes || had.livestock !== livestock) {
        had = { fp: key.fp, level, active, annexes: ind.annexes, livestock, list: make() };
        this.motionOf.set(key, had);
      }
      if (had.list.length) m.list.push({ fp: key.fp, list: had.list });
    };
    for (const ind of game.industries) {
      for (const a of ind.annexes ?? []) take(a, ind, () => annexMotion(ind, a));
      // Заброшенное и стройка не дымят (кран стройки — в плитке).
      if (!ind.ruin && !ind.build) take(ind, ind, () => industryMotion(ind));
    }
    return m.list;
  }

  /** Фонтаны у ратуш и в парках всех городов — пересчёт после правки застройки (Game.townRev, layoutRev). */
  private fountains = { game: null as Game | null, towns: -1, layout: -1, list: [] as { x: number; y: number; r: number }[] };

  private fountainsOf(game: Game): { x: number; y: number; r: number }[] {
    const f = this.fountains;
    if (f.game === game && f.towns === game.townRev && f.layout === game.layoutRev) return f.list;
    f.game = game;
    f.towns = game.townRev;
    f.layout = game.layoutRev;
    f.list = [];
    for (const town of game.towns) {
      for (const b of town.buildings) {
        const h = b.kind === 'landmark' ? hallFountain(b) : null;
        if (h) f.list.push(h);
      }
      for (const p of town.parks ?? []) f.list.push(...parkFountains(p));
    }
    return f.list;
  }

  /** Краны стройплощадок предприятий (drawSiteCrane) — в каждом кадре поверх плиток; опора — подальше от своих станций. */
  private drawSiteCranes(game: Game, view: Box): void {
    const sites = game.industries.filter(
      (i) => i.build && i.fp.center.x > view.x0 - 150 && i.fp.center.x < view.x1 + 150 && i.fp.center.y > view.y0 - 150 && i.fp.center.y < view.y1 + 150,
    );
    if (!sites.length) return;
    const stations = [...game.stations.values()];
    for (const ind of sites) {
      const own = [...(ind.annexes ?? []).map((a) => a.fp)];
      for (const st of stations) {
        if (st.industryId !== ind.id && !st.industryIds.includes(ind.id)) continue;
        own.push(st.fp);
        for (const w of st.warehouses ?? []) own.push(w.fp);
      }
      drawSiteCrane(this.ctx, ind, this.camera.zoom, 0, own);
    }
  }

  /** Станция в рамке view: здание (центр — с запасом 100), у вокзала — и его платформы вдоль путей. */
  private stationSeen(st: Station, view: Box): boolean {
    const c = st.fp.center;
    if (c.x > view.x0 - 100 && c.x < view.x1 + 100 && c.y > view.y0 - 100 && c.y < view.y1 + 100) return true;
    if (st.kind !== 'rail') return false;
    for (const id of st.platforms) {
      const seg = this.cache.get(id);
      if (seg && this.visible(grow(seg.bbox, STATION_TRACK_PAD), view)) return true;
    }
    return false;
  }

  /** Выбрана ли станция st: сама, вторая половина выбранной пары остановок или остановка выбранной линии. */
  private stationPicked(game: Game, o: ToolOverlay): (st: Station) => boolean {
    const sel = o.selection;
    const mate = game.pairOf(sel?.type === 'station' ? game.stations.get(sel.id) : undefined);
    return (st) => (sel?.type === 'station' && sel.id === st.id) || st === mate || o.lineStops.includes(st.id);
  }

  /**
   * Станции — под их неподвижной частью (в кадре): пунктир через улицу у выбранной пары остановок и автобусы на посадке
   * у остановок (навес — поверх них).
   */
  private drawStationsUnder(game: Game, view: Box, o: ToolOverlay): void {
    const sel = o.selection;
    // Выбрана половина пары остановок — выделена и вторая, между ними — пунктир через улицу.
    const picked = sel?.type === 'station' ? game.stations.get(sel.id) : undefined;
    const mate = game.pairOf(picked);
    if (picked && mate && this.stationSeen(picked, view)) this.drawPairLink(picked.fp.center, mate.fp.center, 'rgba(47,128,237,0.9)');
    for (const st of game.stations.values()) if (st.kind === 'stop' && this.stationSeen(st, view)) this.drawStopBuses(game, st);
  }

  /**
   * Станции со складами — неподвижное (в плитках кэша, слой STATIONS, — над машинами на земле): здания, площадки,
   * платформы, склады; выбранная — синей обводкой. Что меняется само (посты цветом машин в них, ящики складов, автобусы)
   * — drawStationsUnder и drawStationsOver.
   */
  private drawStationsStill(game: Game, view: Box, o: ToolOverlay): void {
    const ctx = this.ctx;
    const picked = this.stationPicked(game, o);
    for (const st of game.stations.values()) {
      const selected = picked(st);
      for (const w of st.warehouses ?? []) if (seenAt(w.fp.center, view, 100)) this.drawWarehouse(w.fp, selected);
      // Станция у получателя невидима: на карте сам магазин, в маршруте — его обводка (drawReceivers).
      if (st.kind === 'dock' || !this.stationSeen(st, view)) continue;
      if (st.kind === 'rail') this.drawRailStation(game, st, selected);
      else if (st.kind === 'stop') this.drawStop(game, st, selected);
      else if (st.curb) this.drawCurbTerminal(game, st, selected);
      else if (isBusTerminal(st)) this.drawBusTerminal(game, st, selected);
      else this.drawStation(game, st, selected);
    }
    ctx.globalAlpha = 1;
  }

  /** Станции — поверх неподвижного: занятость постов, ящики и машины на открытых площадках. */
  private drawStationsOver(game: Game, view: Box): void {
    const time = performance.now() / 1000;
    for (const st of game.stations.values()) {
      if (st.kind !== 'road' || st.curb) continue;
      const seen = this.stationSeen(st, view);
      if (isBusTerminal(st)) {
        if (seen) this.drawBusTerminalLive(game, st);
      } else {
        if (seen) this.drawStationBays(game, st);
        const industry = st.industryId === null ? undefined : game.industries.find((ind) => ind.id === st.industryId);
        if (!industry || (!seen && !seenAt(industry.fp.center, view, 400))) continue;
        const work = game.industryHaul.view(st, game.time);
        if (seen) {
          this.ctx.save();
          this.intoStation(game, st);
          if (drawIndustryYardStock(this.ctx, st, industry, this.camera.zoom, game.stationStorage(st), work, time)) this.ambient = true;
          this.ctx.restore();
          this.drawVehicles(game.bayLooks(st));
        }
        if (work?.trips.length && this.camera.zoom > 0.5) {
          drawIndustryTransfer(this.ctx, industry, work);
          if (game.speed > 0) this.ambient = true;
        }
      }
    }
    this.ctx.globalAlpha = 1;
  }

  /**
   * Подпись неподвижной части станции для кэша плиток (drawStationsStill): место и размер, посты и склады, узел выезда
   * и где он, пара остановок, пути вокзала (и их тупики), выбрана ли.
   */
  private stationSig(game: Game, st: Station, selected: boolean): string {
    const node = game.roads.net.nodes.get(st.nodeId);
    const at = node ? `${node.pos.x},${node.pos.y}` : '';
    const rails =
      st.kind === 'rail'
        ? st.platforms
            .map((id) => {
              const s = game.net.segments.get(id);
              return s ? `${s.rev}:${game.net.nodes.get(s.a)?.segments.length}:${game.net.nodes.get(s.b)?.segments.length}` : '-';
            })
            .join(',')
        : '';
    const sheds = (st.warehouses ?? []).map((w) => fpSig(w.fp)).join(';');
    const look = `${st.curb ? 'c' : ''}${st.terminal ? 't' : ''}${isBusTerminal(st) ? 'b' : ''}`;
    return `${fpSig(st.fp)}|${st.kind}|${st.bays}|${st.depots ?? 0}|${at}|${look}|${game.pairOf(st)?.id ?? ''}|${rails}|${sheds}|${selected ? 1 : 0}`;
  }

  /** Рамка неподвижной части станции: здание с тенью и знаками, склады, платформы вокзала вдоль путей. */
  private stationBox(st: Station): Box {
    let box = grow(fpBox(st.fp), 10);
    for (const w of st.warehouses ?? []) box = unite(box, grow(fpBox(w.fp), 6));
    if (st.kind === 'rail') {
      for (const id of st.platforms) {
        const seg = this.cache.get(id);
        if (seg) box = unite(box, grow(seg.bbox, STATION_TRACK_PAD));
      }
    }
    return box;
  }

  /** Склад станции: ангар с двускатной крышей (конёк вдоль), тенью и воротами с торца; у выбранной станции — синей обводкой. */
  private drawWarehouse(fp: Footprint, selected: boolean): void {
    const ctx = this.ctx;
    this.drawFootprint({ ...fp, center: { x: fp.center.x + 2.5, y: fp.center.y + 3 } }, 'rgba(30,40,25,0.22)');
    this.drawFootprint(fp, '#d9c19a', selected ? '#2f80ed' : '#7d5a39', selected ? 2.4 : 1.2);
    ctx.save();
    ctx.translate(fp.center.x, fp.center.y);
    ctx.rotate(fp.angle);
    // Скаты крыши: тёмный — одна половина, конёк посередине, рёбра по скатам.
    ctx.fillStyle = 'rgba(125, 90, 57, 0.28)';
    ctx.fillRect(-fp.w / 2 + 1, 0, fp.w - 2, fp.h / 2 - 1);
    ctx.strokeStyle = 'rgba(92, 70, 50, 0.7)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(-fp.w / 2 + 1, 0);
    ctx.lineTo(fp.w / 2 - 1, 0);
    for (let x = -fp.w / 2 + 4; x < fp.w / 2 - 2; x += 3.5) {
      ctx.moveTo(x, -fp.h / 2 + 1.5);
      ctx.lineTo(x, fp.h / 2 - 1.5);
    }
    ctx.globalAlpha = 0.45;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Ворота с торца.
    ctx.fillStyle = '#5c4632';
    ctx.fillRect(fp.w / 2 - 1.6, -fp.h * 0.22, 1.6, fp.h * 0.44);
    ctx.restore();
  }

  /** Вокзал: островная платформа между путями, боковая у здания и само здание. */
  private drawRailStation(game: Game, st: Station, selected: boolean): void {
    const ctx = this.ctx;
    const tracks = st.platforms.map((id) => game.net.segments.get(id)).filter((s): s is Segment => !!s);
    const main = tracks[0];
    if (main) {
      const mid = main.lut.pointAt(main.length / 2);
      const t = main.lut.tangentAt(main.length / 2);
      // Сторона здания и боковой платформы (stationNormal): у проходной — по зданию, у конечной — по второму пути.
      const n = stationNormal(game.net, st, mid, t);
      const side = n.x * -t.y + n.y * t.x > 0 ? 1 : -1;
      // Пути — по порядку поперёк (путь могли достроить и по другую сторону от главного): от дальнего с другой стороны к зданию.
      const across = tracks
        .map((s, i) => ({ s, off: i === 0 ? 0 : dot(sub(s.lut.pointAt(s.length / 2), mid), n) }))
        .sort((p, q) => p.off - q.off);
      // У конечной платформы доходят до упоров (к перрону у здания в торце), с другого конца — как обычно.
      const dead = (id: number) => game.net.nodes.get(id)?.segments.length === 1;
      const span = (s: Segment): [number, number] => (!st.terminal ? [4, s.length - 4] : dead(s.b) ? [4, s.length] : dead(s.a) ? [0, s.length - 4] : [4, s.length - 4]);
      // Сдвиг — относительно своего направления участка: у конечной пути могут быть уложены навстречу главному.
      const sideOf = (s: Segment) => (dot(s.lut.tangentAt(s.length / 2), t) >= 0 ? side : -side);
      // Островные платформы между соседними путями и боковая — у здания за крайним путём.
      const islands = across.slice(0, -1).map(({ s, off }, i) => ({ s, gap: across[i + 1].off - off }));
      const strips: [Vec[], number][] = [];
      for (const { s, gap } of islands) strips.push([s.lut.offsetPolyline((sideOf(s) * gap) / 2, ...span(s), 6), gap - 2 * RAIL_HALF - 1.5]);
      const last = across[across.length - 1].s;
      strips.push([last.lut.offsetPolyline(sideOf(last) * (RAIL_HALF + 4.5), ...span(last), 6), 6]);
      // Конечная: перрон поперёк путей — от тупиков до здания в торце, во всю его ширину.
      const head = st.terminal ? [main.a, main.b].find(dead) : undefined;
      if (head !== undefined) {
        const fp = st.fp;
        const end = game.net.node(head).pos;
        const across = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
        const toward = dot(sub(fp.center, end), rightNormal(across)) > 0 ? rightNormal(across) : scale(rightNormal(across), -1);
        const depth = dot(sub(fp.center, end), toward) - fp.h / 2;
        if (depth > 0) {
          const c = sub(fp.center, scale(toward, fp.h / 2 + depth / 2));
          strips.push([[sub(c, scale(across, fp.w / 2)), add(c, scale(across, fp.w / 2))], depth + 1]);
        }
      }
      ctx.lineCap = 'butt';
      for (const [pts, w] of strips) {
        ctx.strokeStyle = '#b9b2a6';
        ctx.lineWidth = w + 1.2;
        this.polyline(pts);
        ctx.stroke();
        ctx.strokeStyle = '#e4dfd4';
        ctx.lineWidth = w;
        this.polyline(pts);
        ctx.stroke();
      }
      // Жёлтая линия безопасности у края островных платформ.
      if (this.camera.zoom > 0.6) {
        ctx.strokeStyle = 'rgba(233, 181, 47, 0.8)';
        ctx.lineWidth = 0.6;
        for (const { s, gap } of islands) {
          for (const k of [-1, 1]) {
            this.polyline(s.lut.offsetPolyline((sideOf(s) * gap) / 2 + (k * (gap - 2 * RAIL_HALF - 3)) / 2, ...span(s).map((x, j) => x + (j ? -2 : 2)) as [number, number], 6));
            ctx.stroke();
          }
        }
      }
      // Конечная: на тупике каждого пути — упор, красный брус поперёк с белой полосой.
      if (st.terminal) {
        for (const s of tracks) {
          const atB = dead(s.b);
          if (!atB && !dead(s.a)) continue;
          const at = atB ? s.length - 1.8 : 1.8;
          const p = s.lut.pointAt(at);
          const tg = s.lut.tangentAt(at);
          const hw = RAIL_HALF + 1.5;
          const a = { x: p.x - tg.y * hw, y: p.y + tg.x * hw };
          const b = { x: p.x + tg.y * hw, y: p.y - tg.x * hw };
          ctx.lineCap = 'butt';
          for (const [color, w] of [['#5b2f27', 4], ['#d9534f', 2.8], ['#ffffff', 0.9]] as const) {
            ctx.strokeStyle = color;
            ctx.lineWidth = w;
            this.polyline([a, b]);
            ctx.stroke();
          }
        }
      }
    }
    const fp = st.fp;
    this.drawFootprint({ ...fp, center: { x: fp.center.x + 3, y: fp.center.y + 4 } }, 'rgba(30,40,25,0.22)');
    this.drawFootprint(fp, '#efe7d8', selected ? '#2f80ed' : '#6b5a4a', selected ? 3 : 1.4);
    ctx.save();
    ctx.translate(fp.center.x, fp.center.y);
    ctx.rotate(fp.angle);
    // Крыша с коньком и часами над входом.
    ctx.fillStyle = '#9a5a44';
    ctx.fillRect(-fp.w / 2 + 3, -fp.h / 2 + 3, fp.w - 6, fp.h - 6);
    ctx.strokeStyle = '#7a4434';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-fp.w / 2 + 6, 0);
    ctx.lineTo(fp.w / 2 - 6, 0);
    ctx.stroke();
    ctx.fillStyle = '#f7f3ea';
    ctx.beginPath();
    ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Вагоны всех поездов в кадре: середина, направление, высота и внешний вид. */
  private trainCars(game: Game, view: ReturnType<Renderer['view']>): TrainCar[] {
    const out: TrainCar[] = [];
    for (const train of game.rail.trains.values()) {
      // Строительный поезд на месте работ рисует стройка — за путеукладчиком (drawTrackMachines).
      if (game.construction.trains?.drawnBySite(train.id)) continue;
      // Первый — локомотив, груз — в остальных, по порядку от головы; пассажиры — во всех вагонах поровну.
      const fills = trainWagonFills(train.fill ?? (train.load ? 1 : 0), train.cars - 1, train.kind);
      const cars = game.rail.cars(train);
      const layers = carLayers(
        train,
        cars.map((c) => c.level),
        (id) => railSegLayer(this.cache.get(id)?.maxLevel ?? 0),
      );
      cars.forEach((c, k) => {
        if (c.pos.x < view.x0 || c.pos.x > view.x1 || c.pos.y < view.y0 || c.pos.y > view.y1) return;
        const fill = k ? (fills[k - 1] ?? 0) : 0;
        const layer = layers[k];
        out.push({ ...c, layer, loco: k === 0, color: train.color, load: train.load, fill, kind: train.kind, length: train.carLength, trainId: train.id });
      });
    }
    return out;
  }

  private drawTrains(cars: TrainCar[], halo = false): void {
    if (!cars.length) return;
    const ctx = this.ctx;
    const detailed = this.camera.zoom > 0.5;
    // Вагон — setTransform поверх преобразования холста (base), без save/restore на каждый; стиль после — прежний.
    const m = ctx.getTransform();
    const base: Frame = { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
    ctx.save();
    for (const c of cars) {
      const L = c.length - 1.6;
      const W = 6.6;
      const l = Math.hypot(c.dir.x, c.dir.y);
      setFrame(ctx, base, c.pos.x, c.pos.y, l > 0 ? c.dir.x / l : 1, l > 0 ? c.dir.y / l : 0);
      if (halo) {
        const h = Math.max(1.2, 1.6 / this.camera.zoom);
        ctx.fillStyle = '#ffffff';
        rr(ctx, -L / 2 - h, -W / 2 - h, L + 2 * h, W + 2 * h, 2 + h);
        ctx.fill();
      }
      if (detailed) {
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        rr(ctx, -L / 2 + 1, -W / 2 + 1.2, L, W, 1.6);
        ctx.fill();
      }
      if (c.loco) {
        // Локомотив: тёмный кузов с полосой цвета линии и кабиной впереди.
        ctx.fillStyle = '#34404b';
        rr(ctx, -L / 2, -W / 2, L, W, 2);
        ctx.fill();
        ctx.fillStyle = c.color;
        ctx.fillRect(-L / 2 + 1, -1, L - 2, 2);
        if (detailed) {
          ctx.fillStyle = 'rgba(200, 230, 255, 0.85)';
          ctx.fillRect(L / 2 - 3.2, -W / 2 + 1, 1.6, W - 2);
        }
      } else if (c.kind === 'passenger') {
        ctx.fillStyle = c.color;
        rr(ctx, -L / 2, -W / 2, L, W, 1.6);
        ctx.fill();
        if (detailed) {
          // Окна с пассажирами светятся, пустые — тёмные; занимаются от головы поезда (справа).
          const n = Math.ceil((L - 4) / 3);
          const busy = c.fill > 0 ? Math.ceil(c.fill * n - 1e-6) : 0;
          for (const lit of [false, true]) {
            ctx.fillStyle = lit ? 'rgba(255, 246, 210, 0.95)' : 'rgba(22, 34, 48, 0.5)';
            for (let i = lit ? n - busy : 0; i < (lit ? n : n - busy); i++) {
              const x = -L / 2 + 2 + i * 3;
              ctx.fillRect(x, -W / 2 + 0.7, 1.8, 1);
              ctx.fillRect(x, W / 2 - 1.7, 1.8, 1);
            }
          }
        }
      } else {
        // Грузовой вагон: рама цвета линии, внутри — груз его цветом от передней стенки, остальное — пустой светлый пол.
        // Издалека вагон либо полный, либо пустой: доли в пару пикселей только рябили бы.
        ctx.fillStyle = c.color;
        rr(ctx, -L / 2, -W / 2, L, W, 1.2);
        ctx.fill();
        const f = detailed ? c.fill : c.fill >= 0.5 ? 1 : 0;
        const w = L - 2.4;
        if (f < 1 || !c.load) {
          ctx.fillStyle = '#e6e0d4';
          ctx.fillRect(-L / 2 + 1.2, -W / 2 + 1.2, w, W - 2.4);
        }
        if (f > 0 && c.load) {
          ctx.fillStyle = c.load;
          ctx.fillRect(L / 2 - 1.2 - w * f, -W / 2 + 1.2, w * f, W - 2.4);
        }
      }
    }
    ctx.restore();
  }

  private drawFootprint(fp: Footprint, fill: string | null, stroke?: string, lw = 1): void {
    const ctx = this.ctx;
    ctx.beginPath();
    if (fp.parts) {
      ctx.save();
      ctx.translate(fp.center.x, fp.center.y);
      ctx.rotate(fp.angle);
      for (const part of fp.parts) tracePlot(ctx, part, fp.w, fp.h);
      ctx.restore();
    } else {
      footprintCorners(fp).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
    }
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  }

  /** Предприятие: участок с лёгкой тенью, постройки — в industryArt (мелочи только вблизи); layer — ArtLayer. */
  private drawIndustry(ind: Industry, layer: ArtLayer): void {
    const fp = ind.fp;
    if (ind.info.accepts.length && !fp.compound) {
      const parts = fp.parts?.slice(0, fp.groundParts);
      paintIndustrySite(this.ctx, ind.info, { ...fp, parts, center: { x: fp.center.x + 2, y: fp.center.y + 3 } }, 'rgba(30,40,25,0.16)');
    }
    // Стройплощадка (режим «Строит игрок», «Со строительством»): здание растёт по готовности.
    if (ind.build) {
      drawSiteArt(this.ctx, ind, this.camera.zoom, 0);
      return;
    }
    drawIndustryArt(this.ctx, ind, this.camera.zoom, performance.now() / 1000, layer);
    // Заброшенное: ржавчина, выбитые окна, трава.
    if (ind.ruin) drawRuinOverlay(this.ctx, ind, this.camera.zoom);
  }

  /** Пристройка предприятия: участок с лёгкой тенью, вспомогательное здание — в annexArt; layer — ArtLayer. */
  private drawAnnex(ind: Industry, a: Annex, layer: ArtLayer): void {
    const fp = a.fp;
    const parts = fp.parts?.slice(0, fp.groundParts);
    this.drawFootprint({ ...fp, parts, center: { x: fp.center.x + 2, y: fp.center.y + 3 } }, 'rgba(30,40,25,0.16)');
    drawAnnexArt(this.ctx, ind, a, this.camera.zoom, performance.now() / 1000, layer);
    if (a.connector && this.camera.zoom > 0.4) {
      const at = a.connector[a.connector.length - 1];
      const from = a.connector[a.connector.length - 2];
      drawIndustrialGate(this.ctx, at.x, at.y, Math.atan2(at.y - from.y, at.x - from.x));
    }
  }

  /** Ширины подписей по шрифту и тексту (textWidth): плашки проектов — те же каждый кадр, пока не сменится зум. */
  private readonly textWidths = new Map<string, number>();

  /** Ширина text нынешним шрифтом холста — как measureText, но одна и та же подпись меряется один раз. */
  private textWidth(text: string): number {
    const key = `${this.ctx.font}\n${text}`;
    let w = this.textWidths.get(key);
    if (w === undefined) {
      // Зум меняет шрифт — прежние ширины уже не нужны.
      if (this.textWidths.size > 512) this.textWidths.clear();
      w = this.ctx.measureText(text).width;
      this.textWidths.set(key, w);
    }
    return w;
  }

  /** Рисует картинку значка размером size в мировых единицах. */
  private icon(img: HTMLImageElement, p: Vec, size: number): void {
    if (!img.complete || !img.naturalWidth) {
      // Значок ещё грузится — нарисуем, когда загрузится.
      if (!img.complete) this.moving = true;
      return;
    }
    // Готовым растром размера на экране (iconRaster): SVG-картинку браузер раскладывал бы и рисовал на каждый значок.
    const m = this.ctx.getTransform();
    this.ctx.drawImage(iconRaster(img, size * Math.hypot(m.a, m.b)), p.x - size / 2, p.y - size / 2, size, size);
  }

  /** Автобусы на посадке у остановки — сами автобусы вдоль бордюра, в крайней полосе, носом по ходу (остановка справа). */
  private drawStopBuses(game: Game, st: Station): void {
    if (!st.occupied.length) return;
    const buses: VehicleLook[] = [];
    for (let i = 0; i < st.occupied.length; i++) {
      const berth = game.stopBerthAt(st, i);
      const look = game.fleetLookAt(st.occupied[i], berth.pos, berth.dir);
      if (look) buses.push(look);
      else this.drawFootprint({ center: berth.pos, w: 12, h: 4.6, angle: st.fp.angle }, '#e07b39', '#8a4a22', 0.8);
    }
    this.drawVehicles(buses);
  }

  /** Остановка: навес у края улицы, знак «А» (автобусы на посадке у бордюра — drawStopBuses, под навесом). */
  private drawStop(game: Game, st: Station, selected: boolean): void {
    const ctx = this.ctx;
    const fp = st.fp;
    const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
    // Улица — в сторону узла остановки (он на оси улицы).
    const node = game.roads.net.nodes.get(st.nodeId);
    const toRoad = node ? sub(node.pos, fp.center) : { x: -u.y, y: u.x };
    const l = Math.hypot(toRoad.x, toRoad.y) || 1;
    const n = { x: toRoad.x / l, y: toRoad.y / l };
    this.drawFootprint({ ...fp, center: { x: fp.center.x + 1.5, y: fp.center.y + 2 } }, 'rgba(30,40,25,0.2)');
    this.drawFootprint(fp, '#f3f1ea', selected ? '#2f80ed' : '#5c6470', selected ? 2.4 : 1.2);
    // Крыша навеса — тёмная полоса со стороны тротуара.
    ctx.save();
    ctx.translate(fp.center.x, fp.center.y);
    ctx.rotate(fp.angle);
    ctx.fillStyle = '#5c6470';
    const back = dot(n, { x: -u.y, y: u.x }) > 0 ? -1 : 1;
    ctx.fillRect(-fp.w / 2 + 1.5, back > 0 ? fp.h / 2 - 2.6 : -fp.h / 2 + 1, fp.w - 3, 1.6);
    ctx.restore();
    // Половина пары: на навесе — стрелка, куда едут автобусы, что встают у неё.
    const heading = game.stopHeading(st);
    if (heading) this.drawPairArrow(add(fp.center, scale(n, 0.6)), heading, '#2f80ed', 1);
    // Знак остановки на краю навеса.
    const sign = add(fp.center, scale(u, fp.w / 2 + 2.5));
    ctx.fillStyle = '#2f80ed';
    ctx.beginPath();
    ctx.arc(sign.x, sign.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sign.x, sign.y, 1, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Стрелка хода автобусов у половины пары остановок: по центру at, вдоль dir; k — во сколько раз крупнее навеса. */
  private drawPairArrow(at: Vec, dir: Vec, color: string, k: number): void {
    const ctx = this.ctx;
    const a = add(at, scale(dir, -5.5 * k));
    const b = add(at, scale(dir, 3 * k));
    const side = { x: -dir.y, y: dir.x };
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.1 * k;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const tip = add(at, scale(dir, 6 * k));
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(b.x + side.x * 2 * k, b.y + side.y * 2 * k);
    ctx.lineTo(b.x - side.x * 2 * k, b.y - side.y * 2 * k);
    ctx.closePath();
    ctx.fill();
  }

  /** Пара остановок: пунктир через улицу от навеса к навесу — одна остановка на обе стороны. */
  private drawPairLink(a: Vec, b: Vec, color: string): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 / z;
    ctx.setLineDash([5 / z, 4 / z]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  /** Холст — в координаты площадки станции: начало в центре, x вдоль постов, +y — к воротам (bayFront). */
  private intoStation(game: Game, st: Station): void {
    const ctx = this.ctx;
    const fp = st.fp;
    ctx.translate(fp.center.x, fp.center.y);
    ctx.rotate(fp.angle);
    // Локальная +y — к воротам (у грузового двора предприятия площадка повёрнута наоборот).
    ctx.scale(1, stationRoadFront(st, game.roads.net));
  }

  /**
   * Боксы автостанций и открытая площадка у предприятия. Занятость постов рисуется отдельно в drawStationBays.
   */
  private drawStation(game: Game, st: Station, selected: boolean): void {
    const ctx = this.ctx;
    const fp = st.fp;
    if (st.industryId !== null) {
      if (selected) this.drawFootprint(fp, null, '#2f80ed', 3);
    } else {
      this.drawFootprint({ ...fp, center: { x: fp.center.x + 3, y: fp.center.y + 4 } }, 'rgba(30,40,25,0.22)');
      this.drawFootprint(fp, '#f3f1ea', selected ? '#2f80ed' : '#5c6470', selected ? 3 : 1.4);
    }
    ctx.save();
    this.intoStation(game, st);
    const hh = fp.h / 2;
    if (st.industryId !== null) drawIndustryYard(ctx, st, game.industries.find((ind) => ind.id === st.industryId));
    else {
      ctx.fillStyle = '#5c6470';
      ctx.fillRect(-fp.w / 2 + 3, -hh + 3, fp.w - 6, 4);
    }
    this.drawDepotSides(st, game.bayArea(st));
    ctx.restore();
  }

  /** Длинные посты открываются в общий проезд, на котором можно маневрировать. */
  private drawOpenBayLines(game: Game, st: Station): void {
    const c = this.ctx;
    const row = game.bayArea(st);
    const end = openBayEnd(row.h);
    const rear = openBayRear(row.h);
    c.strokeStyle = C.dash;
    c.lineWidth = 0.55;
    c.lineCap = 'butt';
    c.beginPath();
    for (let i = 0; i < st.bays; i++) {
      const { x, w } = baySlot(row.w, st.bays, i, true);
      c.moveTo(x, end);
      c.lineTo(x, rear);
      c.lineTo(x + w, rear);
      c.lineTo(x + w, end);
    }
    c.stroke();
  }

  /** В открытом дворе короткая цветная полоска отмечает пост перед кабиной. */
  private drawStationBays(game: Game, st: Station): void {
    const ctx = this.ctx;
    const fp = st.fp;
    ctx.save();
    this.intoStation(game, st);
    const hh = fp.h / 2;
    const area = game.bayArea(st);
    this.drawDepotBoxes(game, st, area);
    const open = st.industryId !== null;
    const doors = this.camera.zoom > 0.35;
    game.stationBays(st).forEach((color, i) => {
      const { x, w } = baySlot(area.w, st.bays, i, open);
      if (open) {
        if (color && doors) {
          const center = x + w / 2;
          const front = openBayRear(area.h) + 0.25;
          ctx.fillStyle = '#46505b';
          ctx.fillRect(center - 2.45, front, 4.9, 0.95);
          ctx.fillStyle = color;
          ctx.fillRect(center - 2.1, front + 0.15, 4.2, 0.65);
        }
        return;
      }
      ctx.fillStyle = color ?? '#d5d2c8';
      ctx.fillRect(x, -1, w, hh + 1);
      // Открытые ворота — тёмный проём во всю ширину бокса: контур площадки здесь прерывается.
      if (doors) {
        ctx.fillStyle = '#3d434b';
        ctx.fillRect(x, hh - 2, w, 2.8);
      }
    });
    ctx.restore();
  }

  /** Пристройки-склады — по концам площадки (рисуется в её координатах, +y — к воротам): ангары с двускатной крышей. */
  private drawDepotSides(st: Station, area: Footprint): void {
    const ctx = this.ctx;
    const fp = st.fp;
    const hh = fp.h / 2;
    const side = (fp.w - area.w) / 2;
    if (side <= 0) return;
    for (const k of [-1, 1]) {
      const x0 = k < 0 ? -fp.w / 2 + 1.5 : area.w / 2 + 0.5;
      const w = side - 2;
      ctx.fillStyle = '#b9895a';
      ctx.fillRect(x0, -hh + 1.5, w, fp.h - 3);
      ctx.strokeStyle = '#7d5a39';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(x0, -hh + 1.5, w, fp.h - 3);
      // Конёк крыши поперёк площадки и рёбра кровли.
      ctx.beginPath();
      ctx.moveTo(x0 + w / 2, -hh + 1.5);
      ctx.lineTo(x0 + w / 2, hh - 1.5);
      for (let y = -hh + 5; y < hh - 2; y += 4) {
        ctx.moveTo(x0 + 1, y);
        ctx.lineTo(x0 + w - 1, y);
      }
      ctx.stroke();
    }
  }

  /**
   * Заполнение складов-пристроек (в кадре, поверх ангаров drawDepotSides): ящики у ворот растут вместе с ним. Ответ —
   * где ящики (x, y, w, h в координатах площадки).
   */
  private drawDepotBoxes(game: Game, st: Station, area: Footprint): [number, number, number, number][] {
    const fp = st.fp;
    const side = (fp.w - area.w) / 2;
    if (side <= 0) return [];
    const fill = Math.min(1, game.stationStored(st) / game.stationStorage(st));
    if (fill <= 0.02) return [];
    const hh = fp.h / 2;
    const out: [number, number, number, number][] = [];
    this.ctx.fillStyle = '#e2b866';
    for (const k of [-1, 1]) {
      const x0 = k < 0 ? -fp.w / 2 + 1.5 : area.w / 2 + 0.5;
      const box: [number, number, number, number] = [x0 + 1.5, hh - 1.5 - (fp.h - 4) * fill, Math.min(4, (side - 2) / 3), (fp.h - 4) * fill];
      this.ctx.fillRect(...box);
      out.push(box);
    }
    return out;
  }

  /**
   * Автовокзал — места для автобусов между перронами: у задней стены здание вокзала (синяя кромка навеса), вдоль
   * фасада — посадочная галерея, от неё к выезду — перроны-островки под навесами. Автобус встаёт на своё место носом
   * к зданию, между двумя перронами, — на рисунке он сам, цвета линии (и тот, что заезжает). К выезду площадка
   * открыта: перед местами — асфальт drawStationAprons со стрелками въезда и выезда.
   */
  private drawBusTerminal(game: Game, st: Station, selected: boolean): void {
    const ctx = this.ctx;
    const fp = st.fp;
    const hw = fp.w / 2;
    const hh = fp.h / 2;
    const { area, bw, B, yHall, yGallery, yEnd, pw, x0, shade } = this.busTerminalLayout(game, st);
    ctx.save();
    this.intoStation(game, st);
    // Асфальт мест — заодно с площадкой перед ними; бордюр — по бокам и сзади, к выезду открыто.
    ctx.fillStyle = C.road;
    ctx.fillRect(-hw, -hh, fp.w, fp.h);
    ctx.strokeStyle = selected ? '#2f80ed' : C.roadEdge;
    ctx.lineWidth = selected ? 3 : 1.4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(-hw, hh);
    ctx.lineTo(-hw, -hh);
    ctx.lineTo(hw, -hh);
    ctx.lineTo(hw, hh);
    ctx.stroke();
    this.drawDepotSides(st, area);
    // Тень здания — туда же, куда у остальных зданий (в мире: вправо-вниз).
    ctx.fillStyle = BUS_HALL_SHADOW;
    ctx.fillRect(...shade);
    // Здание вокзала: светлая крыша со световым фонарём, по фасаду — синяя кромка навеса.
    ctx.fillStyle = '#f2efe8';
    ctx.fillRect(x0, yHall, area.w - 2, B);
    ctx.strokeStyle = selected ? '#2f80ed' : '#4f5965';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(x0, yHall, area.w - 2, B);
    ctx.fillStyle = '#d9d4ca';
    ctx.fillRect(x0 + 3, yHall + B * 0.28, area.w - 8, B * 0.26);
    ctx.fillStyle = '#2f80ed';
    ctx.fillRect(x0, yGallery - 1.4, area.w - 2, 1.4);
    // Посадочная галерея вдоль фасада и перроны-островки между местами: бетон, конец к выезду скруглён.
    ctx.fillStyle = '#d7d9dc';
    ctx.fillRect(x0, yGallery, area.w - 2, 1.4);
    for (let i = 0; i <= st.bays; i++) {
      const cx = -area.w / 2 + 4 + i * bw;
      ctx.beginPath();
      ctx.moveTo(cx - pw / 2, yGallery);
      ctx.lineTo(cx - pw / 2, yEnd - pw / 2);
      ctx.arc(cx, yEnd - pw / 2, pw / 2, Math.PI, 0, true);
      ctx.lineTo(cx + pw / 2, yGallery);
      ctx.closePath();
      ctx.fill();
    }
    // Навесы над перронами — синей полосой по оси, от галереи почти до конца перрона.
    ctx.fillStyle = 'rgba(47, 128, 237, 0.8)';
    for (let i = 0; i <= st.bays; i++) {
      const cx = -area.w / 2 + 4 + i * bw;
      ctx.fillRect(cx - pw * 0.22, yGallery - 0.2, pw * 0.44, yEnd - yGallery - pw * 0.9);
    }
    ctx.restore();
  }

  /**
   * Автовокзал — в кадре, поверх неподвижного (drawBusTerminal): ящики складов-пристроек (тень здания, что ложится на
   * них, — снова поверх, как была) и автобусы на местах и на заезде — поверх асфальта (под площадкой их не прячем, как
   * грузовики в боксах).
   */
  private drawBusTerminalLive(game: Game, st: Station): void {
    const ctx = this.ctx;
    const { area, shade } = this.busTerminalLayout(game, st);
    ctx.save();
    this.intoStation(game, st);
    const boxes = this.drawDepotBoxes(game, st, area);
    if (boxes.length) {
      ctx.beginPath();
      for (const b of boxes) ctx.rect(...b);
      ctx.clip();
      ctx.fillStyle = BUS_HALL_SHADOW;
      ctx.fillRect(...shade);
    }
    ctx.restore();
    this.drawVehicles(game.bayLooks(st));
  }

  /** Раскладка автовокзала в координатах площадки (intoStation): места, здание, галерея, перроны, тень здания. */
  private busTerminalLayout(game: Game, st: Station) {
    const fp = st.fp;
    const gate = game.roads.net.nodes.get(st.nodeId);
    const front = gate ? bayFront(fp, gate.pos) : 1;
    const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
    // Локальная +y в мире — к воротам (у грузового двора предприятия площадка повёрнута наоборот).
    const n = { x: -u.y * front, y: u.x * front };
    const hh = fp.h / 2;
    const area = game.bayArea(st);
    const bw = (area.w - 10) / st.bays;
    // Здание — у задней стены (сочленённый автобус встаёт носом к самому фасаду), галерея — вдоль фасада,
    // перроны — от неё почти до края площадки. Здание — 6,5 м, а у старой станции (26 м вглубь, под автобус 18 м) —
    // сколько остаётся за самым длинным автобусом на посту (bayPose: полметра до края площадки), не меньше 2,5.
    const B = clamp(fp.h - 1.5 - LONGEST_BUS, 2.5, 6.5);
    const yHall = -hh + 1;
    const yGallery = yHall + B;
    const yEnd = hh - 2.5;
    // Перрон — сколько остаётся между автобусами (они шириной ~5), но не уже 1.4 и не шире 3.
    const pw = Math.min(3, Math.max(1.4, bw - 7.4));
    const x0 = -area.w / 2 + 1;
    // Тень здания — туда же, куда у остальных зданий (в мире: вправо-вниз).
    const shadow = { x: 2.5, y: 3 };
    const shade: [number, number, number, number] = [x0 + dot(shadow, u), yHall + dot(shadow, n), area.w - 2, B];
    return { area, bw, B, yHall, yGallery, yEnd, pw, x0, shade };
  }

  /** Края улицы у автовокзала у края улицы: в каждой точке вдоль площадки — где бордюр (по полотнам у его узла и соседним). */
  private curbEdge(net: LaneNet, st: Station): ((p: Vec) => Vec | null) | null {
    const node = net.nodes.get(st.nodeId);
    if (!node) return null;
    const near = net.corridorsNear(st.fp.center, st.fp.w / 2 + 60);
    if (!near.length) return null;
    return (p: Vec) => {
      let best: { c: Corridor; s: number; d: number } | null = null;
      for (const c of near) {
        const hit = c.lut.closest(p);
        if (!best || hit.d < best.d) best = { c, s: hit.s, d: hit.d };
      }
      if (!best) return null;
      const e = asphaltEdgesAt(best.c, best.s);
      if (!e) return null;
      const axis = best.c.lut.pointAt(best.s);
      const side = dot(sub(p, axis), rightNormal(best.c.lut.tangentAt(best.s))) > 0 ? 1 : -1;
      return pointOff(best.c, best.s, side > 0 ? e[1] : e[0]);
    };
  }

  /**
   * Разметка мест автовокзала у края улицы — жёлтый зигзаг у бордюра вдоль мест (как у остановки, 1.17): по кромке
   * кармашка, и на отгонах тоже. Под машинами: автобусы встают прямо на неё.
   */
  private drawCurbMarks(net: LaneNet, st: Station): void {
    const ctx = this.ctx;
    const fp = st.fp;
    const curbAt = this.curbEdge(net, st);
    if (!curbAt) return;
    const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
    const node = net.node(st.nodeId);
    // Внутрь улицы от площадки.
    const n0 = { x: -u.y, y: u.x };
    const toRoad = dot(sub(node.pos, fp.center), n0) >= 0 ? n0 : scale(n0, -1);
    const half = fp.w / 2 - STATION.curb.end;
    const pts: Vec[] = [];
    const step = 2.2;
    const count = Math.max(2, Math.round((2 * half) / step));
    for (let i = 0; i <= count; i++) {
      const x = -half + (2 * half * i) / count;
      const probe = add(add(fp.center, scale(u, x)), scale(toRoad, fp.h / 2 + 2));
      const curb = curbAt(probe);
      if (!curb) continue;
      pts.push(add(curb, scale(toRoad, i % 2 ? 2.8 : 0.7)));
    }
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#e8c33a';
    ctx.lineWidth = 0.55;
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Автовокзал у края улицы: вдоль бордюра — перрон под навесом (синие крыши над каждым местом, опоры), за ним —
   * павильон-зал ожидания; знак остановки у переднего края мест. Автобусы стоят на улице — их рисует движение.
   */
  private drawCurbTerminal(game: Game, st: Station, selected: boolean): void {
    const ctx = this.ctx;
    const fp = st.fp;
    const node = game.roads.net.nodes.get(st.nodeId);
    const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
    const n0 = { x: -u.y, y: u.x };
    // Локальная +y — к улице.
    const front = node && dot(sub(node.pos, fp.center), n0) < 0 ? -1 : 1;
    // Вдоль мест — от узла к переднему краю.
    const ahead = node && dot(sub(fp.center, node.pos), u) < 0 ? -1 : 1;
    const hw = fp.w / 2;
    const hh = fp.h / 2;
    const P = 4.6;
    const yPerron = hh - P;
    this.drawFootprint({ ...fp, center: { x: fp.center.x + 2, y: fp.center.y + 2.5 } }, 'rgba(30,40,25,0.18)');
    ctx.save();
    ctx.translate(fp.center.x, fp.center.y);
    ctx.rotate(fp.angle);
    ctx.scale(1, front);
    // Площадка — плитка тротуара; перрон у бордюра — светлее, с жёлтой полосой по краю.
    ctx.fillStyle = '#cfcbc2';
    ctx.fillRect(-hw, -hh, fp.w, fp.h);
    ctx.fillStyle = '#e1e2e4';
    ctx.fillRect(-hw, yPerron, fp.w, P);
    ctx.fillStyle = '#e8c33a';
    ctx.fillRect(-hw + 0.5, hh - 0.9, fp.w - 1, 0.45);
    ctx.strokeStyle = selected ? '#2f80ed' : '#8b8f96';
    ctx.lineWidth = selected ? 2.4 : 0.9;
    ctx.strokeRect(-hw, -hh, fp.w, fp.h);
    // Павильон — у дальнего края: светлая крыша, фонарь посередине, синяя кромка навеса по фасаду.
    const B = fp.h - P - 1.2;
    const bw = Math.min(fp.w - 4, Math.max(12, fp.w * 0.55));
    const bx = -bw / 2 - ahead * (fp.w - bw) * 0.18;
    ctx.fillStyle = 'rgba(30,40,25,0.22)';
    ctx.fillRect(bx + 1.2, -hh + 0.6 + 1.4, bw, B);
    ctx.fillStyle = '#f2efe8';
    ctx.fillRect(bx, -hh + 0.6, bw, B);
    ctx.strokeStyle = selected ? '#2f80ed' : '#4f5965';
    ctx.lineWidth = selected ? 1.8 : 0.9;
    ctx.strokeRect(bx, -hh + 0.6, bw, B);
    ctx.fillStyle = '#d9d4ca';
    ctx.fillRect(bx + 2, -hh + 0.6 + B * 0.32, bw - 4, B * 0.3);
    ctx.fillStyle = '#2f80ed';
    ctx.fillRect(bx, -hh + 0.6 + B - 1, bw, 1);
    // Навес над перроном — по крыше над каждым местом (синие), между ними — просвет; опоры у бордюра.
    const C = STATION.curb;
    const stand = fp.w - 2 * C.end;
    const k = Math.max(1, st.bays);
    const seg = stand / k;
    for (let i = 0; i < k; i++) {
      const x0 = -stand / 2 + i * seg + 0.8;
      ctx.fillStyle = 'rgba(47, 128, 237, 0.85)';
      ctx.fillRect(x0, yPerron + 0.6, seg - 1.6, P - 2);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(x0, yPerron + 0.6, seg - 1.6, 0.5);
      ctx.fillStyle = '#4f5965';
      for (const x of [x0 + 0.6, x0 + seg - 2.2]) ctx.fillRect(x, hh - 1.9, 0.7, 0.7);
    }
    ctx.restore();
    // Знак остановки — у переднего края мест, на бордюре.
    const sign = add(add(fp.center, scale(u, ahead * (stand / 2 + C.end * 0.5))), scale(n0, front * (hh - 1.2)));
    ctx.fillStyle = '#2f80ed';
    ctx.beginPath();
    ctx.arc(sign.x, sign.y, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sign.x, sign.y, 0.7, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Площадка перед воротами автостанций: прямоугольник во всю ширину здания, состыкованный с выездом
   * двумя скруглениями с каждой стороны — вогнутым у кромки улицы и выпуклым на углу площадки;
   * без бордюра поперёк. На площадке — «зубцы» между местами и стрелки к воротам.
   * Рисуется под машинами: по ней они и заезжают в боксы.
   */
  private drawStationAprons(game: Game, net: LaneNet, view: ReturnType<Renderer['view']>): void {
    const ctx = this.ctx;
    for (const st of game.stations.values()) {
      if (st.kind !== 'road') continue;
      const fp = st.fp;
      if (fp.center.x < view.x0 - 100 || fp.center.x > view.x1 + 100 || fp.center.y < view.y0 - 100 || fp.center.y > view.y1 + 100) continue;
      if (st.industryId !== null && !st.curb) {
        this.drawFootprint(fp, C.road);
        // Маневровый проезд идёт вдоль всего ряда: отдельные въезды и выезды делят одну площадку.
        ctx.save();
        this.intoStation(game, st);
        ctx.fillStyle = C.road;
        const start = fp.h / 2 - 1;
        ctx.beginPath();
        ctx.roundRect(-fp.w / 2, start, fp.w, industryApronEnd(fp.h) - start, [0, 0, 6, 6]);
        ctx.fill();
        ctx.restore();
      }
      if (st.curb) {
        if (this.camera.zoom >= 0.3) this.drawCurbMarks(net, st);
        continue;
      }
      const front = stationRoadFront(st, net);
      const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
      const v = scale(rightNormal(u), front);
      const nearEdge = add(fp.center, scale(v, fp.h / 2 - 1));
      for (const gate of additionalStationGates(st, net)) {
        const end = net.ends(gate)[0];
        if (!end) continue;
        const road = end.corridor;
        const s = end.end === 'a' ? 0 : road.length;
        const [left, right] = edgesAt(road, s) ?? [-LANE_W / 2, LANE_W / 2];
        const margin = corridorMargin(road);
        const a = add(pointOff(road, s, left - margin), scale(end.away, 0.7));
        const b = add(pointOff(road, s, right + margin), scale(end.away, 0.7));
        const side = gate.stationGateSide;
        const atEdge = (p: Vec) => side
          ? add(add(fp.center, scale(u, side * (fp.w / 2 - 1))), scale(v, dot(sub(p, fp.center), v)))
          : add(nearEdge, scale(u, clamp(dot(sub(p, fp.center), u), -fp.w / 2 + 1, fp.w / 2 - 1)));
        ctx.fillStyle = C.road;
        if (side) {
          const depth = Math.max(dot(sub(a, nearEdge), v), dot(sub(b, nearEdge), v));
          ctx.save();
          ctx.translate(nearEdge.x, nearEdge.y);
          ctx.rotate(fp.angle);
          ctx.scale(1, front);
          ctx.fillRect(-fp.w / 2, 0, fp.w, depth);
          ctx.restore();
        }
        ctx.beginPath();
        this.polyline([a, b, atEdge(b), atEdge(a)]);
        ctx.closePath();
        ctx.fill();
        if (st.industryId !== null && !side) this.drawIndustryGateShoulders(net, end);
      }
      const node = net.nodes.get(st.nodeId);
      const end = node && net.ends(node)[0];
      if (!node || !end) {
        if (st.industryId !== null && this.camera.zoom >= 0.35) {
          ctx.save();
          this.intoStation(game, st);
          this.drawOpenBayLines(game, st);
          ctx.restore();
        }
        continue;
      }
      // Координаты площадки: x вдоль боксов, y к выезду (здание — до hh).
      const local = (p: Vec) => ({ x: dot(sub(p, fp.center), u), y: dot(sub(p, fp.center), v) });
      const hh = fp.h / 2;
      // Кромки выезда у ворот — x слева и справа (выезд подходит к площадке поперёк фасада).
      const c = end.corridor;
      const s = end.end === 'a' ? 0 : c.length;
      const ed = edgesAt(c, s) ?? [-LANE_W / 2, LANE_W / 2];
      if (st.side) {
        // Станция вдоль дороги: асфальт от фасада до дублёра во всю ширину площадки — посты выходят прямо на него, и
        // там, где к нему примыкает площадка, нет ни бордюра, ни краевой линии. Дублёр к краям площадки чуть изгибается —
        // край асфальта идёт по его кромке (по обеим половинам у узла), заходя за краевую линию.
        const halves = node.corridors.map((id) => net.corridors.get(id)).filter((x): x is Corridor => !!x);
        const edgeY = (x: number): number => {
          const p = add(fp.center, add(scale(u, x), scale(v, hh)));
          let best = Infinity;
          let y = hh;
          for (const h of halves) {
            const hit = h.lut.closest(p);
            if (hit.d >= best) continue;
            const e = edgesAt(h, hit.s) ?? [-LANE_W / 2, LANE_W / 2];
            best = hit.d;
            y = Math.min(...e.map((o) => local(pointOff(h, hit.s, o)).y));
          }
          // Краевая линия — по кромке полосы, шириной около метра (издалека — не тоньше пикселя): закрываем с запасом.
          return y + 0.9 + 1.5 / Math.max(this.camera.zoom, 0.5);
        };
        const xs: number[] = [];
        for (let x = -fp.w / 2; x < fp.w / 2; x += 2) xs.push(x);
        xs.push(fp.w / 2);
        const ys = xs.map(edgeY);
        ctx.save();
        ctx.translate(fp.center.x, fp.center.y);
        ctx.rotate(fp.angle);
        ctx.scale(1, front);
        ctx.fillStyle = C.road;
        ctx.beginPath();
        ctx.moveTo(-fp.w / 2, hh - 1.5);
        xs.forEach((x, i) => ctx.lineTo(x, ys[i]));
        ctx.lineTo(fp.w / 2, hh - 1.5);
        ctx.closePath();
        ctx.fill();
        // Бордюр по бокам — от угла площадки до дублёра.
        ctx.strokeStyle = C.roadEdge;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(-fp.w / 2, hh - 1.5);
        ctx.lineTo(-fp.w / 2, ys[0] - 1.6);
        ctx.moveTo(fp.w / 2, hh - 1.5);
        ctx.lineTo(fp.w / 2, ys[ys.length - 1] - 1.6);
        ctx.stroke();
        if (this.camera.zoom >= 0.35) {
          if (st.industryId === null) this.drawBayMarks(game, st, hh);
          else this.drawOpenBayLines(game, st);
        }
        ctx.restore();
        continue;
      }
      const margin = corridorMargin(c);
      const [l, r] = [ed[0] - margin, ed[1] + margin].map((o) => local(pointOff(c, s, o)).x).sort((a, b) => a - b);
      /** Радиус скруглений, если хватает места. */
      const R0 = 6;
      // Глубина площадки — 16 от фасада, но скругление у улицы не ближе 14 к другому концу выезда (там перекрёсток).
      const gy = local(node.pos).y;
      const Y = Math.max(gy + 1.5, Math.min(hh + 16, gy + c.length - 14 - R0 - 1.5));
      // Бока площадки — по углам здания (и не уже выезда), чуть заходя под здание.
      const X0 = Math.min(-fp.w / 2 + 1, l);
      const X1 = Math.max(fp.w / 2 - 1, r);
      const y0 = hh - 1.5;
      // Два скругления поровну; места мало — оба меньше, прямого участка между ними нет.
      const rl = Math.min(R0, (l - X0) / 2);
      const rr = Math.min(R0, (X1 - r) / 2);
      ctx.save();
      ctx.translate(fp.center.x, fp.center.y);
      ctx.rotate(fp.angle);
      ctx.scale(1, front);
      // Бордюр — под асфальтом, как у дорог: от кромки улицы вогнутым скруглением наружу,
      // вдоль площадки, выпуклым скруглением на её углу — и вдоль улицы к углу здания.
      ctx.strokeStyle = C.roadEdge;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(l, Y + rl);
      ctx.arc(l - rl, Y + rl, rl, 0, -Math.PI / 2, true);
      ctx.lineTo(X0 + rl, Y);
      ctx.arc(X0 + rl, Y - rl, rl, Math.PI / 2, Math.PI);
      ctx.lineTo(X0, y0);
      ctx.moveTo(r, Y + rr);
      ctx.arc(r + rr, Y + rr, rr, Math.PI, Math.PI * 1.5);
      ctx.lineTo(X1 - rr, Y);
      ctx.arc(X1 - rr, Y - rr, rr, Math.PI / 2, 0, true);
      ctx.lineTo(X1, y0);
      if (st.industryId === null) ctx.stroke();
      // Асфальт: тот же контур; поперёк выезда (там уже асфальт) — чуть дальше, чтобы закрыть концы бордюра.
      ctx.fillStyle = C.road;
      ctx.beginPath();
      ctx.moveTo(X0, y0);
      ctx.lineTo(X0, Y - rl);
      ctx.arc(X0 + rl, Y - rl, rl, Math.PI, Math.PI / 2, true);
      ctx.lineTo(l - rl, Y);
      ctx.arc(l - rl, Y + rl, rl, -Math.PI / 2, 0);
      ctx.lineTo(l, Y + rl + 1.5);
      ctx.lineTo(r, Y + rr + 1.5);
      ctx.lineTo(r, Y + rr);
      ctx.arc(r + rr, Y + rr, rr, Math.PI, Math.PI * 1.5);
      ctx.lineTo(X1 - rr, Y);
      ctx.arc(X1 - rr, Y - rr, rr, Math.PI / 2, 0, true);
      ctx.lineTo(X1, y0);
      ctx.closePath();
      ctx.fill();
      if (this.camera.zoom >= 0.35) {
        if (st.industryId === null) this.drawBayMarks(game, st, hh);
        else this.drawOpenBayLines(game, st);
        // Въезд и выезд: правая по ходу полоса выезда ведёт на площадку, левая — обратно к улице.
        const axis = local(pointOff(c, s, 0)).x;
        const lanes = [ed[0] / 2, ed[1] / 2].map((o) => local(pointOff(c, s, o)).x);
        const inSide = Math.sign(dot(rightNormal(scale(v, -1)), u)) || 1;
        const xIn = (lanes[0] - axis) * inSide > 0 ? lanes[0] : lanes[1];
        const xOut = xIn === lanes[0] ? lanes[1] : lanes[0];
        this.drawEntryExit(xIn, xOut, hh + 4.5, Y);
      }
      ctx.restore();
    }
  }

  /** Плавное уширение у ворот, пока прицеп ещё доворачивает на подъездной дороге. */
  private drawIndustryGateShoulders(net: LaneNet, end: CorridorEnd): void {
    const c = end.corridor;
    if (net.node(c.a).level !== 0 || net.node(c.b).level !== 0) return;
    const length = Math.min(30, c.length - 6);
    if (length < 8) return;
    const ctx = this.ctx;
    for (const side of [0, 1] as const) {
      const sign = side ? 1 : -1;
      const inner: Vec[] = [];
      const outer: Vec[] = [];
      for (let i = 0; i <= 8; i++) {
        const u = i / 8;
        const s = end.end === 'a' ? length * u : c.length - length * u;
        const edges = asphaltEdgesAt(c, s);
        if (!edges) continue;
        const width = 2.5 * (1 - u * u);
        inner.push(pointOff(c, s, edges[side] - sign * 0.6 * (1 - u)));
        outer.push(pointOff(c, s, edges[side] + sign * width));
      }
      this.polyline([...inner, ...outer.reverse()]);
      ctx.closePath();
      ctx.fill();
    }
  }

  /**
   * Разметка перед постами (в координатах площадки, +y — к выезду, фасад — на hh): «зубцы» между местами — продолжают
   * стенки между боксами (у автовокзала — перроны), стрелка к воротам каждого бокса. Посты — без пристроек-складов.
   */
  private drawBayMarks(game: Game, st: Station, hh: number): void {
    const ctx = this.ctx;
    const area = game.bayArea(st);
    const bw = (area.w - 10) / st.bays;
    ctx.strokeStyle = C.dash;
    ctx.lineWidth = 0.8;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (let i = 0; i <= st.bays; i++) {
      const x = -area.w / 2 + 4 + i * bw;
      ctx.moveTo(x, hh);
      ctx.lineTo(x, hh + 3.5);
    }
    ctx.stroke();
    ctx.fillStyle = C.dash;
    for (let i = 0; i < st.bays; i++) {
      const cx = -area.w / 2 + 5 + i * bw + (bw - 2) / 2;
      ctx.beginPath();
      ctx.moveTo(cx, hh + 1.2);
      ctx.lineTo(cx + 1.8, hh + 3.6);
      ctx.lineTo(cx - 1.8, hh + 3.6);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** Стрелки на площадке перед постами: по полосе xIn к постам, по xOut — к улице. */
  private drawEntryExit(xIn: number, xOut: number, y0: number, y1: number): void {
    const ctx = this.ctx;
    const len = Math.min(7, y1 - y0 - 1);
    if (len < 3) return;
    const mid = (y0 + y1) / 2;
    ctx.fillStyle = C.dash;
    /** Стрелка вдоль полосы x: остриё в yHead, хвост — на len от него. */
    const arrow = (x: number, yHead: number, toward: 1 | -1) => {
      const head = Math.min(2.4, len * 0.45);
      const yTail = yHead - toward * len;
      const yNeck = yHead - toward * head;
      ctx.beginPath();
      ctx.moveTo(x - 0.4, yTail);
      ctx.lineTo(x - 0.4, yNeck);
      ctx.lineTo(x - 1.3, yNeck);
      ctx.lineTo(x, yHead);
      ctx.lineTo(x + 1.3, yNeck);
      ctx.lineTo(x + 0.4, yNeck);
      ctx.lineTo(x + 0.4, yTail);
      ctx.closePath();
      ctx.fill();
    };
    arrow(xIn, mid - len / 2, -1);
    arrow(xOut, mid + len / 2, 1);
  }

  /**
   * Грузы на станциях и оптовых базах — поверх линий маршрутов, на белых плашках. У остановки в первой плашке
   * впереди — значок автобуса; никто не ждёт — плашка из одного значка (им остановка видна и издалека).
   * Сколько ушло пешком — только у выбранной станции (`selected`): у всех сразу эти плашки загромождают карту.
   */
  private drawStationBadges(game: Game, view: ReturnType<Renderer['view']>, selected: number | null): void {
    const z = this.camera.zoom;
    if (z <= 0.22) return;
    const ctx = this.ctx;
    let styled = false;
    for (const st of game.stations.values()) {
      const stop = st.kind === 'stop';
      if (!stop && z < STATION_BADGES_ZOOM) continue;
      const depot = st.dock && game.isDepotDock(st) ? game.buildingById(st.dock.b)?.fp : undefined;
      if (st.kind === 'dock' && !depot) continue;
      const fp = depot ?? st.fp;
      if (fp.center.x < view.x0 || fp.center.x > view.x1 || fp.center.y < view.y0 || fp.center.y > view.y1) continue;
      const waiting: [CargoType | 'walk', number][] = FREIGHT.map((c) => [c, Math.floor(st.cargo[c] ?? 0)] as [CargoType, number]).filter(([, n]) => n > 0);
      let pax = 0;
      for (const n of st.passengers.values()) pax += n;
      if (pax > 0) waiting.push(['passengers', Math.floor(pax)]);
      // Ушли за месяц, не дождавшись места в автобусе (game/paxPatience.ts), — серый значок с идущим человеком;
      // только у выбранной станции, у остальных это число — в совете «Пассажиры уходят».
      const gone = st.id === selected ? paxGone(st) : 0;
      if (gone > 0) waiting.push(['walk', gone]);
      if (!waiting.length && !stop) continue;
      // Шрифт и выравнивание — одни на все плашки: раз, перед первой.
      if (!styled) {
        styled = true;
        ctx.font = `700 ${11 / z}px system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
      }
      /** Место под значок автобуса в начале плашки. */
      const lead = stop ? 18 / z : 0;
      const widths = waiting.length ? waiting.map(([, n], i) => (i ? 0 : lead) + 22 / z + ctx.measureText(String(n)).width + 6 / z) : [18 / z];
      const total = widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * (4 / z);
      let x = fp.center.x - total / 2;
      // Над зданием; название станции — ещё выше (drawLabels). Дорога сверху — под зданием, под названием.
      const y = !depot && labelsBelow(game, st) ? bottomOf(fp) + NAME_RISE / z : topOf(fp) - BADGE_RISE / z;
      widths.forEach((w, i) => {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.strokeStyle = 'rgba(60,70,80,0.25)';
        ctx.lineWidth = 1 / z;
        ctx.beginPath();
        ctx.roundRect(x, y - 9 / z, w, 18 / z, 9 / z);
        ctx.fill();
        ctx.stroke();
        if (stop && !i) this.busIcon({ x: x + 9 / z, y }, 17 / z);
        const item = waiting[i];
        if (item) {
          const x0 = x + (i ? 0 : lead);
          const walk = item[0] === 'walk';
          this.icon(walk ? walkImage() : cargoImage(item[0] as CargoType), { x: x0 + 9 / z, y }, 15 / z);
          ctx.fillStyle = walk ? '#5b6670' : '#1f2933';
          ctx.fillText(String(item[1]), x0 + 19 / z, y + 0.5 / z);
        }
        x += w + 4 / z;
      });
    }
  }

  /**
   * Значки предупреждений (stationWarnings: где, какие, что сказать): у станции или предприятия, где что-то не так, —
   * кружок с «!» в правом верхнем углу (красный — стоит, жёлтый — теряете деньги или рост), у станции, где все посты
   * заняты и машины давно ждут въезда, — красная плашка «въезд запрещён» с числом ждущих в левом. Одного размера
   * при любом масштабе; наведение — причина одной строкой, клик — карточка с объяснением (controller).
   */
  private drawWarningMarks(game: Game, view: ReturnType<Renderer['view']>): void {
    const z = this.camera.zoom;
    const ctx = this.ctx;
    let styled = false;
    for (const m of warningMarks(game, z)) {
      if (m.x + m.hw < view.x0 || m.x - m.hw > view.x1 || m.y + m.hh < view.y0 || m.y - m.hh > view.y1) continue;
      // Кромка, шрифт и выравнивание — одни на все значки: раз, перед первым.
      if (!styled) {
        styled = true;
        ctx.lineWidth = 2 / z;
        ctx.strokeStyle = '#fff';
        ctx.font = `800 ${12 / z}px system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
      }
      if (m.shape === 'dot') {
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.hw, 0, Math.PI * 2);
        ctx.fillStyle = m.level === 'alert' ? '#e5534b' : '#e0a100';
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText('!', m.x, m.y + 0.5 / z);
        continue;
      }
      const x = m.x - m.hw;
      ctx.beginPath();
      ctx.roundRect(x, m.y - m.hh, m.hw * 2, m.hh * 2, m.hh);
      ctx.fillStyle = '#e5534b';
      ctx.fill();
      ctx.stroke();
      // Знак «въезд запрещён»: белый круг с красной чертой.
      const cx = x + 11 / z;
      ctx.beginPath();
      ctx.arc(cx, m.y, 6.5 / z, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.fillStyle = '#e5534b';
      ctx.fillRect(cx - 4 / z, m.y - 1.4 / z, 8 / z, 2.8 / z);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(String(m.count ?? ''), x + 20 / z, m.y + 0.5 / z);
    }
  }

  private drawLabels(game: Game, view: ReturnType<Renderer['view']>): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const text = (p: Vec, s: string, size: number, color: string, bg?: string) => {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(1 / z, 1 / z);
      ctx.font = `700 ${size}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (bg) {
        const w = ctx.measureText(s).width + 12;
        ctx.fillStyle = bg;
        rr(ctx, -w / 2, -size * 0.75, w, size * 1.5, 6);
        ctx.fill();
      }
      ctx.lineWidth = 3;
      // Обводка букв — со скруглёнными углами: острый угол (miter) у «М», «Ж», «у» торчит белым шипом.
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      if (!bg) ctx.strokeText(s, 0, 0);
      ctx.fillStyle = color;
      ctx.fillText(s, 0, 0);
      ctx.restore();
    };
    const near = (p: Vec, pad: number) => p.x > view.x0 - pad && p.x < view.x1 + pad && p.y > view.y0 - pad && p.y < view.y1 + pad;
    for (const t of game.towns) {
      if (!near(t.center, t.radius + 400)) continue;
      const top = { x: t.center.x, y: t.top - 26 / z };
      text(top, t.labelOnly ? t.name : `${t.name} · ${t.population}`, 15, '#1f2933');
      // Потребности города: яркий значок — привозили достаточно в прошлом месяце.
      const n = t.demands.length;
      const need = lastTownNeed(t);
      // С получателями под каждым значком — точки «●●○»: значки чуть реже, чтобы ряды точек не сливались.
      const gap = game.retail ? 30 : 24;
      t.demands.forEach((c, i) => {
        const p = { x: t.center.x + ((i - (n - 1) / 2) * gap) / z, y: top.y + 20 / z };
        const ok = (t.lastSupplied[c] ?? 0) >= need;
        ctx.globalAlpha = ok ? 1 : 0.55;
        this.icon(cargoImage(c), p, 20 / z);
        ctx.globalAlpha = 1;
        if (ok) {
          ctx.strokeStyle = '#2e9d57';
          ctx.lineWidth = 2.5 / z;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 11.5 / z, 0, Math.PI * 2);
          ctx.stroke();
        }
        // Получатели (world/retail.ts): под значком точки «●●○» — сколько магазинов этого груза снабжено из всех.
        if (game.retail) this.drawStockDots(stockedCount(t, c, game.time), { x: p.x, y: p.y + 15 / z });
      });
    }
    // Месторождения (режим «Строит игрок»): значок ресурса и точки размера ●●○ — подписью; вблизи видно и так.
    // Издали (весь регион в кадре) точки гаснут — остаётся один значок (sizeDotsVisibility).
    if (z < 0.9) {
      const dots = sizeDotsVisibility(z);
      for (const d of game.enterprises.deposits) {
        if (d.used !== undefined || !near(d.center, 120)) continue;
        const s = (z <= 0.3 ? 18 : 15) / z;
        ctx.globalAlpha = 0.9;
        this.icon(cargoImage(INDUSTRY_TYPES[d.kind].produces), d.center, s);
        ctx.globalAlpha = dots;
        if (dots > 0) text({ x: d.center.x, y: d.center.y + s * 0.8 }, sizeDots(d.size), 9, '#2b2d31', 'rgba(255,255,255,0.75)');
        ctx.globalAlpha = 1;
      }
    }
    const e = game.enterprises;
    for (const ind of game.industries) {
      if (!near(ind.fp.center, 200)) continue;
      if (z <= 0.3) {
        // Издалека предприятие видно как значок продукции; заброшенное и стройка — бледным.
        if (ind.ruin || ind.build) ctx.globalAlpha = 0.45;
        this.icon(cargoImage(ind.info.produces), ind.fp.center, 24 / z);
        ctx.globalAlpha = 1;
        continue;
      }
      // Рецепт — по центру здания, название — под нижним краем.
      const bottom = bottomOf(ind.fp);
      this.drawRecipe(ind, ind.fp.center);
      text({ x: ind.fp.center.x, y: bottom + 14 / z }, ind.info.name, 12, '#3b4652');
      // Режим «Строит игрок»: стройка, заброшенное, нехватка рабочих — плашкой над зданием.
      if (!e.on) continue;
      const top = topOf(ind.fp);
      const badge = ind.build
        ? `🏗 ${Math.floor(ind.build.done * 100)}%${e.stalls.get(ind.id) === 'base' ? ' · ⛔ нет базы' : e.stalls.get(ind.id) === 'money' || e.stalls.get(ind.id) === 'upkeep' ? ' · 💸' : ''}`
        : ind.ruin
          ? '🏚 заброшено'
          : e.staff(ind) < 0.995
            ? `👷 ${Math.round(e.staff(ind) * 100)}%`
            : '';
      if (badge) text({ x: ind.fp.center.x, y: top - 12 / z }, badge, 11, '#ffffff', ind.ruin ? 'rgba(110,100,85,0.85)' : 'rgba(35,45,60,0.82)');
    }
    if (z > 0.22) {
      for (const st of game.stations.values()) {
        if (st.industryId !== null || st.kind === 'dock') continue;
        // Остановок в городе много: издалека — только значок автобуса на плашке ожидающих, название — вблизи.
        if (st.kind === 'stop' && z < STOP_NAMES_ZOOM) continue;
        // Сверху вниз: название, плашка ожидающих, станция. Место плашки держим и пустым,
        // чтобы название не прыгало, когда груз забрали; плашек ещё не видно — название на её месте.
        const rise = st.kind === 'stop' || z >= STATION_BADGES_ZOOM ? NAME_RISE : BADGE_RISE;
        // Дорога сверху — столбик под остановкой: сначала название, под ним плашка.
        const y = labelsBelow(game, st) ? bottomOf(st.fp) + BADGE_RISE / z : topOf(st.fp) - rise / z;
        // У половины пары название общее — со стрелкой, куда отсюда едут автобусы.
        const heading = st.kind === 'stop' ? game.stopHeading(st) : null;
        text({ x: st.fp.center.x, y }, heading ? `${st.name} ${headingArrow(heading)}` : st.name, 11, '#ffffff', 'rgba(35,45,60,0.82)');
      }
    }
  }

  /** Точки «●●○» под значком потребности: заполненные — снабжённые получатели, пустые — нет (не больше 6). */
  private drawStockDots(n: { stocked: number; total: number }, at: Vec): void {
    if (!n.total) return;
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const k = Math.min(6, n.total);
    const step = 4.6 / z;
    const r = 1.9 / z;
    for (let i = 0; i < k; i++) {
      const x = at.x + (i - (k - 1) / 2) * step;
      ctx.beginPath();
      ctx.arc(x, at.y, r, 0, Math.PI * 2);
      ctx.fillStyle = i < n.stocked ? '#2e9d57' : 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.lineWidth = 1 / z;
      ctx.strokeStyle = i < n.stocked ? '#1f6f3d' : '#7b8794';
      ctx.stroke();
    }
  }

  /**
   * Грузы, чьих получателей подсветить: продукция выбранного предприятия, груз выбранной машины (пустой — грузы её
   * маршрута), грузы выбранного маршрута, груз, выбранный в «Цепочках».
   */
  private focusCargo(game: Game, o: ToolOverlay): Set<CargoType> {
    const out = new Set<CargoType>();
    if (o.cargoFocus) out.add(o.cargoFocus);
    const sel = o.selection;
    if (sel?.type === 'industry') {
      const ind = game.industries.find((i) => i.id === sel.id);
      if (ind) out.add(ind.info.produces);
    }
    const lineOf = (id: number | null) => (id === null ? undefined : game.lines.get(id));
    if (sel?.type === 'fleet') {
      const v = game.fleet.get(sel.id);
      if (v?.cargo) out.add(v.cargo);
      else for (const c of (v && lineOf(v.lineId) && game.lineFreight(lineOf(v.lineId)!)) || []) out.add(c);
    }
    const line = lineOf(o.selectedLine);
    if (line) for (const c of game.lineFreight(line)) out.add(c);
    return out;
  }

  /**
   * Получатели грузов (world/retail.ts) вблизи: над домом — значок груза в кружке, кольцо — насколько полон склад
   * (зелёное, жёлтое, красное мигающее); к двору не подъехать — серый кружок с ⛔. Выбран груз (предприятие, маршрут,
   * машина, «Цепочки») — его получатели пульсируют и видны издали, остальные приглушены. От грузовой станции к
   * получателям в её охвате — тонкие линии со значком груза: что она здесь сдаёт.
   */
  private drawReceivers(game: Game, view: Box, o: ToolOverlay): void {
    if (!game.retail) return;
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const focus = this.focusCargo(game, o);
    // Магазины задания «Развезти по двум магазинам» (этап A): подсвечены и со стрелкой, пока задание не выполнено.
    const goal = goalShops(game);
    const close = z >= RECEIVER_ZOOM;
    const preview = o.receiverPreview;
    const move = o.receiverMovePreview;
    const connected = new Set(preview?.receivers.map(({ b }) => b.id));
    if (!close && !focus.size && !goal.size && !preview && !move) return;
    const inView = (p: Vec, pad: number) => p.x > view.x0 - pad && p.x < view.x1 + pad && p.y > view.y0 - pad && p.y < view.y1 + pad;
    const pulse = 0.5 + 0.5 * Math.sin((performance.now() / 1000) * 5);
    // От станции — к её получателям: линии под значками.
    const links = (a: Vec, receivers: ReturnType<Game['stationReceivers']>, planned = false) => {
      for (const { b, r } of receivers) {
        const c = r.cargo.find((x) => focus.has(x)) ?? r.cargo[0];
        const rc = roofCenter(b);
        const e = lotFrame(b)(rc.x, rc.y);
        ctx.save();
        ctx.globalAlpha = planned ? 1 : focus.size && !focus.has(c) ? 0.3 : 0.85;
        ctx.strokeStyle = CARGO[c].color;
        ctx.lineWidth = (planned ? 2.4 : 1.6) / z;
        ctx.setLineDash([6 / z, 4 / z]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const m = { x: a.x + (e.x - a.x) * 0.4, y: a.y + (e.y - a.y) * 0.4 };
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(m.x, m.y, 7.5 / z, 0, Math.PI * 2);
        ctx.fill();
        this.icon(cargoImage(c), m, 13 / z);
        ctx.restore();
      }
    };
    if (z >= STATION_LINKS_ZOOM && !preview) {
      const exclude = move ? [move.receiver.b.id] : [];
      for (const st of game.stations.values()) {
        if (st.kind === 'dock' || !st.serves.cargo || !inView(st.fp.center, 300)) continue;
        links(st.fp.center, game.stationReceivers(st, exclude));
      }
    }
    if (preview) links(preview.at, preview.receivers, true);
    if (move) for (const st of move.stations) links(st.fp.center, [move.receiver], true);
    for (const town of game.towns) {
      if (!town.receivers?.length || !inView(town.center, (town.extent ?? town.radius) + 200)) continue;
      const byId = this.buildingsOf(town);
      for (const r of town.receivers) {
        const b = byId.get(r.b);
        if (!b || !inView(b.fp.center, 40)) continue;
        const target = goal.get(r.b);
        const focused = r.cargo.some((c) => focus.has(c));
        const covered = connected.has(b.id);
        const hot = focused || !!target || covered;
        if (!close && !hot) continue;
        // Оптовая база — один значок (выбранный груз или больше всего лежащий на её складе), кольцо — склад базы.
        const depot = r.depot ? game.depotStock(r.b) : null;
        const list = target
          ? [target]
          : focused
            ? r.cargo.filter((c) => focus.has(c)).slice(0, depot ? 1 : undefined)
            : depot
              ? [depot.top ?? r.cargo[0]]
              : r.cargo;
        const reach = game.docks.reachable(b, 12);
        const size = (hot ? 24 : 19) / z;
        // Над крышей здания (не над двором, где грузовик); несколько грузов — в ряд вдоль улицы.
        const at = lotFrame(b);
        const roof = roofCenter(b);
        ctx.save();
        const dim = preview ? !covered : focus.size && !hot;
        ctx.globalAlpha = dim ? 0.35 : 1;
        if (covered) this.drawFootprint({ ...b.fp, w: b.fp.w + 4, h: b.fp.h + 4 }, 'rgba(47,128,237,0.12)', '#2f80ed', 2.5 / z);
        if (target) {
          // Задание: стрелка над магазином покачивается — «сюда».
          const o0 = at(roof.x, roof.y);
          this.goalArrow({ x: o0.x, y: o0.y - size * (1.05 + 0.25 * pulse) }, size);
        }
        list.forEach((c, i) => {
          const o0 = at(roof.x, roof.y);
          const p = { x: o0.x + (i - (list.length - 1) / 2) * size * 1.25, y: o0.y };
          if (hot) {
            // Пульс: кольцо расходится от значка.
            ctx.strokeStyle = CARGO[c].color;
            ctx.lineWidth = 2.5 / z;
            ctx.globalAlpha = 0.35 + 0.5 * (1 - pulse);
            ctx.beginPath();
            ctx.arc(p.x, p.y, size * (0.75 + 0.35 * pulse), 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          ctx.fillStyle = reach ? '#ffffff' : '#c9cdd3';
          ctx.beginPath();
          ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
          ctx.fill();
          if (!reach) ctx.globalAlpha *= 0.55;
          this.icon(cargoImage(c), p, size * 0.72);
          ctx.globalAlpha = dim ? 0.35 : 1;
          // Кольцо — наполненность склада: по часовой от верха. У оптовой базы — синее, без мигания: пустая база —
          // не беда, это склад-пересадка.
          const fill = depot ? depot.fill : stockFill(town, r, c, game.time);
          const color = depot ? '#3f74b5' : fill >= 0.5 ? '#2e9d57' : fill >= 0.2 ? '#e0a800' : '#d64545';
          ctx.lineWidth = 2.6 / z;
          ctx.strokeStyle = 'rgba(60,66,76,0.35)';
          ctx.beginPath();
          ctx.arc(p.x, p.y, size / 2 + 1.2 / z, 0, Math.PI * 2);
          ctx.stroke();
          if (reach && (depot ? fill > 0 : fill >= 0.2 || this.blinkOn)) {
            ctx.strokeStyle = color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, size / 2 + 1.2 / z, -Math.PI / 2, -Math.PI / 2 + Math.max(0.08, fill) * Math.PI * 2);
            ctx.stroke();
          }
          if (!depot && fill < 0.2) this.moving = true;
          if (depot) {
            // Значок пересадки «⇄» — база, а не магазин.
            const q = { x: p.x - size * 0.4, y: p.y - size * 0.4 };
            ctx.fillStyle = '#3f74b5';
            ctx.beginPath();
            ctx.arc(q.x, q.y, size * 0.24, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = `${size * 0.34}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('⇄', q.x, q.y);
          }
          if (!reach) {
            // Не подъехать: ⛔ у кружка.
            const q = { x: p.x + size * 0.38, y: p.y - size * 0.38 };
            ctx.fillStyle = '#d64545';
            ctx.beginPath();
            ctx.arc(q.x, q.y, size * 0.22, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(q.x - size * 0.13, q.y - size * 0.04, size * 0.26, size * 0.08);
          }
          // Выбран груз (маршрут, машина, предприятие, задание): под значком — сколько магазин примет сейчас, «+7».
          const room = hot && reach && !depot ? roomFor(town, r, c, game.time) : 0;
          if (room >= 1) {
            const text = `+${room}`;
            const fs = size * 0.46;
            ctx.font = `bold ${fs}px sans-serif`;
            const w = ctx.measureText(text).width + fs * 0.7;
            const q = { x: p.x, y: p.y + size * 0.78 };
            ctx.fillStyle = '#2e9d57';
            ctx.beginPath();
            ctx.roundRect(q.x - w / 2, q.y - fs * 0.62, w, fs * 1.24, fs * 0.62);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, q.x, q.y + fs * 0.04);
          }
        });
        ctx.restore();
        if (hot) this.moving = true;
      }
    }
  }

  /** Дома города по id — для значков получателей (drawReceivers): пересчёт, когда список домов заменили или он вырос. */
  private readonly townIndex = new WeakMap<Town, { list: TownBuilding[]; n: number; byId: Map<number, TownBuilding> }>();

  private buildingsOf(town: Town): Map<number, TownBuilding> {
    let had = this.townIndex.get(town);
    if (!had || had.list !== town.buildings || had.n !== town.buildings.length) {
      had = { list: town.buildings, n: town.buildings.length, byId: new Map(town.buildings.map((b) => [b.id, b])) };
      this.townIndex.set(town, had);
    }
    return had.byId;
  }

  /** Стрелка задания вниз, к значку магазина: остриё — в точке tip, size — размер значка под ней. */
  private goalArrow(tip: Vec, size: number): void {
    const ctx = this.ctx;
    const w = size * 0.5;
    const h = size * 0.75;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ff8a1f';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = size * 0.08;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - w, tip.y - h * 0.55);
    ctx.lineTo(tip.x - w * 0.42, tip.y - h * 0.55);
    ctx.lineTo(tip.x - w * 0.42, tip.y - h);
    ctx.lineTo(tip.x + w * 0.42, tip.y - h);
    ctx.lineTo(tip.x + w * 0.42, tip.y - h * 0.55);
    ctx.lineTo(tip.x + w, tip.y - h * 0.55);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }

  /** Значок остановки: синий силуэт автобуса (вид сбоку, нос вправо) для белой плашки; size — квадрат 24×24 значка. */
  private busIcon(at: Vec, size: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.scale(size / 24, size / 24);
    ctx.translate(-12, -12);
    ctx.fillStyle = '#2f80ed';
    ctx.beginPath();
    ctx.roundRect(3, 6.3, 18, 9.6, [2, 3.2, 1.2, 1.2]);
    ctx.fill();
    // Два окна и лобовое стекло; колёса — с белым зазором от кузова, как арки.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(4.6, 7.9, 4.2, 3.4, 0.5);
    ctx.roundRect(10, 7.9, 4.2, 3.4, 0.5);
    ctx.roundRect(15.4, 7.9, 4, 4.4, [0.5, 1.6, 0.5, 0.5]);
    for (const x of [7.6, 16.4]) {
      ctx.moveTo(x + 2.7, 15.9);
      ctx.arc(x, 15.9, 2.7, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = '#1f2933';
    ctx.beginPath();
    for (const x of [7.6, 16.4]) {
      ctx.moveTo(x + 1.9, 15.9);
      ctx.arc(x, 15.9, 1.9, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
  }

  /** Плашка-рецепт под предприятием: [сырьё] + [сырьё] → [продукт]. */
  private drawRecipe(ind: Industry, at: Vec): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const icon = 16 / z;
    const gap = 5 / z;
    const arrow = 12 / z;
    const inputs = ind.info.accepts;
    const width = (inputs.length ? inputs.length * icon + (inputs.length - 1) * gap + arrow + gap * 2 : 0) + icon + 10 / z;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.roundRect(at.x - width / 2, at.y - 11 / z, width, 22 / z, 11 / z);
    ctx.fill();
    let x = at.x - width / 2 + 5 / z + icon / 2;
    for (const c of inputs) {
      this.icon(cargoImage(c), { x, y: at.y }, icon);
      x += icon + gap;
    }
    if (inputs.length) {
      ctx.strokeStyle = '#55606e';
      ctx.fillStyle = '#55606e';
      ctx.lineWidth = 1.6 / z;
      const ax = x - icon / 2;
      ctx.beginPath();
      ctx.moveTo(ax, at.y);
      ctx.lineTo(ax + arrow - 3 / z, at.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ax + arrow, at.y);
      ctx.lineTo(ax + arrow - 4 / z, at.y - 3 / z);
      ctx.lineTo(ax + arrow - 4 / z, at.y + 3 / z);
      ctx.fill();
      x += arrow + gap;
    }
    this.icon(cargoImage(ind.info.produces), { x, y: at.y }, icon);
  }

  // ---------- Оверлеи ----------

  /**
   * Машина маршрута, на которую навели в его списке: пульсирующее синее кольцо (как у предприятий из цепочек)
   * поверх её кружка на маршруте — не меньше кружка, чтобы было видно и издалека.
   */
  private drawFleetHover(game: Game, id: number, lineId: number | null): void {
    const v = game.fleet.get(id);
    const spot = v && v.lineId === lineId ? game.fleetSpot(v) : null;
    if (!spot) return;
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
    // На посту автостанции — сам пост, пока его видно; издалека — кольцом, как остальных.
    if (spot.box && spot.box.w * z >= 6) {
      this.drawBayMark(spot.box, (1 + pulse * 1.5) / z, `rgba(47, 128, 237, ${0.6 + pulse * 0.4})`);
      return;
    }
    const r = Math.max(spot.r, 12 / z) + (4 + pulse * 6) / z;
    ctx.lineWidth = 6 / z;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    ctx.arc(spot.pos.x, spot.pos.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 4 / z;
    ctx.strokeStyle = `rgba(47, 128, 237, ${0.6 + pulse * 0.4})`;
    ctx.stroke();
  }

  /** Пост автостанции, где стоит машина: рамка по боксу на pad шире (белая подложка, сверху цветная) и лёгкая заливка. */
  private drawBayMark(box: Footprint, pad: number, color: string): void {
    const z = this.camera.zoom;
    const fp = { ...box, w: box.w + pad * 2, h: box.h + pad * 2 };
    this.drawFootprint(fp, 'rgba(255, 255, 255, 0.25)', 'rgba(255, 255, 255, 0.9)', 5 / z);
    this.drawFootprint(fp, 'rgba(47, 128, 237, 0.15)', color, 3 / z);
  }

  /** Точка с графика скорости — на маршруте: кружок цвета линии в белой обводке и плашка со скоростью над ним. */
  private drawChartPoint(p: { pos: Vec; color: string; kmh: number }): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const { x, y } = p.pos;
    ctx.save();
    ctx.fillStyle = 'rgba(31, 41, 51, 0.18)';
    ctx.beginPath();
    ctx.arc(x, y, 14 / z, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = p.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3 / z;
    ctx.beginPath();
    ctx.arc(x, y, 7 / z, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const text = `${p.kmh} км/ч`;
    ctx.font = `700 ${12 / z}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 12 / z;
    const h = 18 / z;
    const top = y - 14 / z - h;
    ctx.fillStyle = '#1f2933';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, top, w, h, 6 / z);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, top + h / 2);
    ctx.restore();
  }

  /** Ратуша, площадь, парк на новом месте (перенос, поворот): их рисунком, полупрозрачно; нельзя — красной заливкой. */
  private drawGhosts(list: NonNullable<ToolOverlay['ghosts']>, trees: readonly string[]): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    for (const g of list) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      if (g.park) drawParkArt(ctx, g.park, z, trees);
      if (g.building) drawHouseArt(ctx, g.building, z, trees);
      ctx.restore();
      const fp = g.park?.fp ?? g.building?.fp;
      if (fp && !g.ok) this.drawFootprint(fp, 'rgba(232, 72, 63, 0.35)', '#e8483f', 2 / z);
    }
  }

  /** Ручка поворота ↺ — кружок за дальним краем, тонкая линия к середине (тянут — линия ярче). */
  private drawTurnHandle(h: NonNullable<ToolOverlay['turnHandle']>): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const hr = HANDLE_PX / z;
    ctx.save();
    ctx.strokeStyle = h.active ? '#2f80ed' : 'rgba(47,128,237,0.6)';
    ctx.lineWidth = 1.5 / z;
    ctx.setLineDash([4 / z, 3 / z]);
    ctx.beginPath();
    ctx.moveTo(h.pivot.x, h.pivot.y);
    ctx.lineTo(h.pos.x, h.pos.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = h.active ? '#2f80ed' : '#fff';
    ctx.strokeStyle = '#2f80ed';
    ctx.lineWidth = 2 / z;
    ctx.beginPath();
    ctx.arc(h.pos.x, h.pos.y, hr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = h.active ? '#fff' : '#2f80ed';
    ctx.font = `bold ${hr * 1.6}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('↺', h.pos.x, h.pos.y + hr * 0.08);
    ctx.restore();
  }

  private drawBuildingResize(overlay: NonNullable<ToolOverlay['buildingResize']>): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const preview = overlay.preview;
    const stroke = preview && !preview.ok ? '#e8483f' : preview ? '#2d9e60' : '#2f80ed';
    ctx.save();
    if (preview) this.drawFootprint(preview.fp, preview.ok ? 'rgba(45,158,96,0.18)' : 'rgba(232,72,63,0.25)', stroke, 2.5 / z);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2 / z;
    for (const corner of overlay.corners) {
      const active = overlay.active?.side === corner.side && overlay.active.edge === corner.edge;
      const size = (corner.edge === 'front' ? HANDLE_PX - 1.5 : HANDLE_PX) / z;
      ctx.fillStyle = active ? stroke : '#fff';
      ctx.beginPath();
      ctx.roundRect(corner.pos.x - size, corner.pos.y - size, size * 2, size * 2, 1.5 / z);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Площадка-стоянка: прежнее место (перенос) пунктиром, новое — с местами и воротами, ручки углов и поворота. */
  private drawLotOverlay(o: LotOverlay): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    if (o.old) {
      ctx.save();
      ctx.translate(o.old.center.x, o.old.center.y);
      ctx.rotate(o.old.angle);
      ctx.strokeStyle = 'rgba(224,71,60,0.8)';
      ctx.setLineDash([5 / z, 4 / z]);
      ctx.lineWidth = 1.5 / z;
      ctx.strokeRect(-o.old.w / 2, -o.old.h / 2, o.old.w, o.old.h);
      ctx.restore();
    }
    drawLotPreview(ctx, o, z);
    const hr = HANDLE_PX / z;
    for (const h of o.handles) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#2f80ed';
      ctx.lineWidth = 2 / z;
      ctx.beginPath();
      if (h.kind === 'rotate') ctx.arc(h.pos.x, h.pos.y, hr, 0, Math.PI * 2);
      else ctx.rect(h.pos.x - hr, h.pos.y - hr, 2 * hr, 2 * hr);
      ctx.fill();
      ctx.stroke();
      if (h.kind === 'rotate') {
        ctx.fillStyle = '#2f80ed';
        ctx.font = `bold ${hr * 1.6}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('↺', h.pos.x, h.pos.y + hr * 0.08);
      }
    }
  }

  private drawOverlay(game: Game, o: ToolOverlay): void {
    const cursor = o.buildingResize?.cursor ?? '';
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
    const ctx = this.ctx;
    if (o.footpath) {
      const { a, b, ok } = o.footpath;
      ctx.save();
      ctx.strokeStyle = ok ? '#2f80ed' : '#df403c';
      ctx.lineWidth = Math.max(FOOTPATH.width, 2 / this.camera.zoom);
      ctx.lineCap = 'round';
      this.polyline([a, b]);
      ctx.stroke();
      ctx.restore();
    }
    for (const t of o.parkingTargets ?? []) {
      ctx.save();
      ctx.translate(t.pos.x, t.pos.y);
      ctx.rotate(Math.atan2(t.dir.y, t.dir.x));
      ctx.fillStyle = t.free ? 'rgba(47,128,237,0.12)' : 'rgba(232,72,63,0.18)';
      ctx.strokeStyle = t.free ? '#2f80ed' : '#cf4d46';
      ctx.lineWidth = 1 / this.camera.zoom;
      ctx.fillRect(-4.5, -2.2, 9, 4.4);
      ctx.strokeRect(-4.5, -2.2, 9, 4.4);
      ctx.restore();
    }
    if (o.parkingPreview) {
      const p = o.parkingPreview;
      this.drawTripAhead(p.pts, p.ok ? '#2f80ed' : '#cf4d46', { pos: p.goal, r: 5 });
      ctx.save();
      ctx.translate(p.goal.x, p.goal.y);
      ctx.rotate(Math.atan2(p.dir.y, p.dir.x));
      ctx.fillStyle = p.ok ? 'rgba(47,128,237,0.35)' : 'rgba(232,72,63,0.35)';
      ctx.fillRect(-4.5, -2.2, 9, 4.4);
      ctx.restore();
    }
    if (o.vehicleGhost) {
      const { look, ok } = o.vehicleGhost;
      ctx.save(); ctx.globalAlpha = 0.45; this.drawVehicles([look]); ctx.restore();
      ctx.save();
      ctx.translate(look.pos.x - look.dir.x * look.length / 2, look.pos.y - look.dir.y * look.length / 2);
      ctx.rotate(Math.atan2(look.dir.y, look.dir.x));
      ctx.strokeStyle = ok ? '#299b62' : '#cf4d46';
      ctx.lineWidth = 2 / this.camera.zoom;
      ctx.strokeRect(-look.length / 2 - 0.4, -look.width / 2 - 0.4, look.length + 0.8, look.width + 0.8);
      ctx.restore();
    }
    if (o.lot) this.drawLotOverlay(o.lot);
    if (o.corridor) {
      const color = { red: 'rgba(232,72,63,0.5)', blue: 'rgba(47,128,237,0.35)', green: 'rgba(46,157,87,0.4)' }[o.corridor.color];
      this.tintCorridor(o.roads?.net ?? game.roads.net, o.corridor.id, color);
    }
    // Полоса — в той сети, что на карте (в проекте полос — в сети с ним).
    if (o.lane) this.tintLane(o.roads?.net ?? game.roads.net, o.lane.corridor, o.lane.lane, 'rgba(232,72,63,0.55)');
    const curbTint = { green: 'rgba(46,157,87,0.55)', yellow: 'rgba(229,163,59,0.6)', red: 'rgba(232,72,63,0.55)' };
    for (const x of o.curbLanes ?? []) this.tintLane(o.roads?.net ?? game.roads.net, x.corridor, x.lane, curbTint[x.color]);
    for (const pt of o.points ?? []) {
      // Узлы, за которые тянут, — квадратом (как у проекта), поверх перьев: ниже, после них.
      if (pt.node) continue;
      const z = this.camera.zoom;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeStyle = pt.color;
      ctx.lineWidth = 2 / z;
      ctx.beginPath();
      ctx.arc(pt.pos.x, pt.pos.y, (pt.r ?? 6) / z, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    this.drawPartners(game, o.selection);
    if (o.industry) this.drawIndustryPreview(game, o.industry);
    if (o.highlight.length) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
      ctx.strokeStyle = `rgba(47, 128, 237, ${0.5 + pulse * 0.5})`;
      ctx.lineWidth = 4 / this.camera.zoom;
      for (const id of o.highlight) {
        const ind = game.industries.find((i) => i.id === id);
        if (!ind) continue;
        ctx.beginPath();
        ctx.arc(ind.fp.center.x, ind.fp.center.y, footprintRadius(ind.fp) + (10 + pulse * 8) / this.camera.zoom, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (o.area) {
      // Рамка сноса: красный пунктир, всё, что снесётся, — красным.
      const z = this.camera.zoom;
      const { a, b } = o.area;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(232, 72, 63, 0.75)';
      for (const id of o.area.segs) {
        const s = game.net.segments.get(id);
        if (!s) continue;
        ctx.lineWidth = halfWidth(s.spec) * 2 + 4;
        this.polyline(s.lut.points);
        ctx.stroke();
      }
      // Дороги: снесётся только то, что внутри рамки.
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      const inside = (p: Vec) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
      for (const id of o.area.corridors) {
        const c = game.roads.net.corridors.get(id);
        if (!c) continue;
        ctx.lineWidth = c.lanes.length * LANE_W + 6;
        for (const [s0, s1] of insideRuns(c, inside)) {
          const n = Math.max(2, Math.ceil((s1 - s0) / 4));
          this.polyline(Array.from({ length: n + 1 }, (_, i) => c.lut.pointAt(s0 + ((s1 - s0) * i) / n)));
          ctx.stroke();
        }
      }
      for (const fp of o.area.fps) this.drawFootprint({ ...fp, w: fp.w + 4, h: fp.h + 4 }, 'rgba(232,72,63,0.35)', '#e8483f', 2 / z);
      ctx.fillStyle = 'rgba(232, 72, 63, 0.08)';
      ctx.strokeStyle = '#e8483f';
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([8 / z, 6 / z]);
      ctx.beginPath();
      ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (o.ping) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 150);
      ctx.strokeStyle = `rgba(47, 128, 237, ${0.6 + pulse * 0.4})`;
      ctx.lineWidth = 4 / this.camera.zoom;
      ctx.beginPath();
      ctx.arc(o.ping.pos.x, o.ping.pos.y, o.ping.r + (10 + pulse * 10) / this.camera.zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (o.catchmentAt) {
      ctx.fillStyle = 'rgba(47, 128, 237, 0.08)';
      ctx.strokeStyle = 'rgba(47, 128, 237, 0.5)';
      ctx.lineWidth = 2 / this.camera.zoom;
      ctx.setLineDash([8 / this.camera.zoom, 6 / this.camera.zoom]);
      ctx.beginPath();
      ctx.arc(o.catchmentAt.x, o.catchmentAt.y, o.catchmentR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Выбрана машина или поезд компании — показываем маршрут её линии, чтобы было видно, куда она едет.
    const fleetLine = o.selection?.type === 'fleet' ? game.fleet.get(o.selection.id)?.lineId : undefined;
    const shownLine = o.selectedLine ?? fleetLine ?? null;
    const selFleet = o.selection?.type === 'fleet' ? game.fleet.get(o.selection.id) : undefined;
    // Подсветку и обводку машин линии рисует сама линия — под значками груза.
    if (shownLine !== null) this.drawLinePath(game, shownLine, shownLine === o.selectedLine ? (o.fleetHover ?? null) : null, selFleet?.lineId === shownLine ? selFleet : undefined);
    if (o.chartPoint) this.drawChartPoint(o.chartPoint);
    if (o.selection?.type === 'fleet') {
      // Станция, к которой машина едет сейчас, — кольцом цвета линии.
      const v = game.fleet.get(o.selection.id);
      const line = v && game.lines.get(v.lineId);
      const st = line && game.stations.get(line.stops[v.stop]);
      const yardGoal = v && game.fleetYardDestination(v);
      if (v && line && yardGoal) {
        this.drawTripAhead(null, line.color, { pos: yardGoal.fp.center, r: footprintRadius(yardGoal.fp) });
      } else if (st) {
        const z = this.camera.zoom;
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
        ctx.strokeStyle = line.color;
        ctx.lineWidth = 3 / z;
        ctx.beginPath();
        ctx.arc(st.fp.center.x, st.fp.center.y, footprintRadius(st.fp) + (8 + pulse * 6) / z, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // Прокладываемый маршрут — сразу цветом, который получит линия.
    if (o.lineStops.length > 1) this.drawStopsRoute(game, o.lineStops, game.newLineColor(o.lineStops), false);
    for (const m of o.marks) {
      ctx.globalAlpha = 0.8;
      if (m.warn) this.drawFootprint(m.fp, 'rgba(229, 163, 59, 0.4)', '#e5a33b', 2 / this.camera.zoom);
      else this.drawFootprint(m.fp, m.ok ? '#cfe3ff' : 'rgba(232, 72, 63, 0.45)', m.ok ? '#2f80ed' : '#e8483f', 2 / this.camera.zoom);
      ctx.globalAlpha = 1;
    }
    if (o.ghosts?.length) this.drawGhosts(o.ghosts, BIOMES[game.terrain.biome].palette.trees);
    if (o.selection?.type === 'building' && !o.buildingResize?.preview) {
      const b = game.buildingById(o.selection.id);
      if (b) this.drawFootprint(b.fp, 'rgba(47,128,237,0.12)', '#2f80ed', 2.5 / this.camera.zoom);
    }
    if (o.buildingResize) this.drawBuildingResize(o.buildingResize);
    if (o.selection?.type === 'park') {
      // Парк — тот же контур, что у выбранного здания, но заливка слабее: зелень под ней видна.
      const fp = game.parkById(o.selection.id)?.fp;
      if (fp) this.drawFootprint({ ...fp, w: fp.w + 4, h: fp.h + 4 }, 'rgba(47,128,237,0.07)', '#2f80ed', 2.5 / this.camera.zoom);
    }
    if (o.turnHandle) this.drawTurnHandle(o.turnHandle);
    if (o.template) {
      // Предпросмотр развязки: все дороги и съезды полупрозрачной полосой.
      ctx.lineCap = 'round';
      ctx.strokeStyle = o.template.ok ? 'rgba(80, 160, 255, 0.5)' : 'rgba(232, 72, 63, 0.5)';
      ctx.lineWidth = 9;
      for (const c of o.template.curves) {
        this.polyline(new CurveLUT(c).points);
        ctx.stroke();
      }
    }
    if (o.frame) {
      const z = this.camera.zoom;
      ctx.fillStyle = o.frame.ok ? 'rgba(47, 128, 237, 0.06)' : 'rgba(232, 72, 63, 0.06)';
      ctx.strokeStyle = o.frame.ok ? '#2f80ed' : '#e8483f';
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([8 / z, 6 / z]);
      ctx.beginPath();
      o.frame.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (o.signal) {
      // Будущий сигнал и стрелка — для поездов какого направления он будет.
      const { pos, dir, remove } = o.signal;
      const color = remove ? '#e8483f' : '#2f80ed';
      const z = this.camera.zoom;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2 / z;
      const a = add(pos, scale(dir, -14));
      const b = add(pos, scale(dir, 14));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(b.x + dir.x * 4, b.y + dir.y * 4);
      ctx.lineTo(b.x - dir.y * 3.5, b.y + dir.x * 3.5);
      ctx.lineTo(b.x + dir.y * 3.5, b.y - dir.x * 3.5);
      ctx.fill();
      this.signalPost(add(pos, scale({ x: -dir.y, y: dir.x }, RAIL_HALF + 4)), dir, remove ? '#e8483f' : '#3ad16b', !!o.signal.oneWay && !remove);
    }
    if (o.station) {
      if (o.station.haulRoad) drawIndustrialRoads(ctx, [o.station.haulRoad.map(({ x, y }) => [x, y])], 'rgba(47,128,237,0.65)');
      ctx.globalAlpha = 0.75;
      this.drawFootprint(o.station.fp, o.station.ok ? '#cfe3ff' : '#f5c3bf', o.station.ok ? '#2f80ed' : '#e8483f', 2);
      ctx.globalAlpha = 1;
      if (o.railPreview) {
        ctx.lineCap = 'round';
        ctx.strokeStyle = o.station.ok ? 'rgba(80, 160, 255, 0.6)' : 'rgba(232, 72, 63, 0.6)';
        ctx.lineWidth = 2 * RAIL_HALF;
        for (const c of o.railPreview) {
          this.polyline(new CurveLUT(c).points);
          ctx.stroke();
        }
      }
    }
    // Встанет парой к остановке напротив: обе обведены, пунктир через улицу, на каждой — куда едут её автобусы.
    if (o.stopPair) {
      const [a, b] = o.stopPair;
      this.drawPairLink(a.fp.center, b.fp.center, 'rgba(47,128,237,0.95)');
      this.drawFootprint(b.fp, 'rgba(207,227,255,0.55)', '#2f80ed', 2);
      for (const h of o.stopPair) this.drawPairArrow(h.fp.center, h.dir, '#2f80ed', 1.25);
    }
    for (const p of [o.plan, ...(o.plans ?? [])]) {
      if (!p?.lut) continue;
      const e = roadEdges(p.spec);
      const off = (e.right - e.left) / 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = p.ok ? 'rgba(80, 160, 255, 0.55)' : 'rgba(232, 72, 63, 0.55)';
      ctx.lineWidth = e.left + e.right;
      this.polyline(p.lut!.offsetPolyline(off, 0, p.lut!.length, 3));
      ctx.stroke();
      // Высота: подписи уровня на концах, если они разные.
      ctx.fillStyle = '#ffffff';
      for (const c of p.crossings) {
        ctx.beginPath();
        ctx.arc(c.point.x, c.point.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (p.levelA !== p.levelB || p.levelA !== 0) {
        const lut = p.lut as CurveLUT;
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.2;
        this.polyline(lut.offsetPolyline(off, 0, lut.length, 6));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (o.project) this.drawProject(o.project);
    if (o.liveSigns?.length && this.camera.zoom >= 0.45) {
      // Знаки поворотов дороги, которую тянут, — по её форме прямо сейчас, как у построенной.
      const r = Math.max(3.2, 9 / this.camera.zoom);
      ctx.save();
      this.signText(r);
      for (const s of o.liveSigns) this.limitSign(add(s.pos, scale(rightNormal(s.dir), s.side - ROAD_MARGIN + 3 + r)), r, s.kmh);
      ctx.restore();
    }
    if (o.control && o.chainStart) {
      ctx.strokeStyle = 'rgba(47,128,237,0.7)';
      ctx.lineWidth = 1.5 / this.camera.zoom;
      ctx.setLineDash([4 / this.camera.zoom, 4 / this.camera.zoom]);
      ctx.beginPath();
      ctx.moveTo(o.chainStart.pos.x, o.chainStart.pos.y);
      ctx.lineTo(o.control.x, o.control.y);
      if (o.snap) ctx.lineTo(o.snap.pos.x, o.snap.pos.y);
      ctx.stroke();
      ctx.setLineDash([]);
      this.marker(o.control, '#2f80ed', 'square');
    }
    if (o.handles?.length) {
      // Перья: линии от концов к управляющим точкам, сами точки — кружками; перья соседних дорог — бледнее.
      const z = this.camera.zoom;
      ctx.lineWidth = 1.5 / z;
      for (const partner of [true, false]) {
        ctx.strokeStyle = partner ? 'rgba(47,128,237,0.45)' : 'rgba(47,128,237,0.85)';
        ctx.beginPath();
        for (const h of o.handles) {
          if (h.partner !== partner) continue;
          ctx.moveTo(h.anchor.x, h.anchor.y);
          ctx.lineTo(h.pos.x, h.pos.y);
        }
        ctx.stroke();
      }
      for (const h of o.handles) {
        ctx.fillStyle = h.active ? '#2f80ed' : h.partner ? '#dce9fb' : '#ffffff';
        ctx.strokeStyle = h.partner && !h.active ? 'rgba(47,128,237,0.6)' : '#2f80ed';
        ctx.lineWidth = 2 / z;
        ctx.beginPath();
        ctx.arc(h.pos.x, h.pos.y, (h.partner ? HANDLE_PX * 0.85 : HANDLE_PX) / z, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    // Узлы — поверх линий перьев (квадрат не перечёркнут): «Двигать» и проект.
    for (const pt of o.points ?? []) if (pt.node) this.nodeMark(pt.pos, { hot: (pt.r ?? 6) > 7, color: pt.color === '#2f80ed' ? undefined : pt.color });
    for (const n of o.project?.nodes ?? []) this.nodeMark(n.pos, { hot: n.hot, tip: n.tip });
    if (o.chainStart) this.marker(o.chainStart.pos, '#2f80ed', o.chainStart.kind === 'free' ? 'small' : 'ring');
    if (o.snap) this.marker(o.snap.pos, o.plan && !o.plan.ok ? '#e8483f' : '#2f80ed', o.snap.kind === 'free' ? 'small' : 'ring');
    if (o.highlightSeg !== null) {
      const s = game.net.segments.get(o.highlightSeg);
      const c = s && this.cache.get(s.id);
      if (c) {
        // Красным — под снос, синим — то, что двигаем или гнём.
        ctx.strokeStyle = o.highlightEdit ? 'rgba(47, 128, 237, 0.35)' : 'rgba(232, 72, 63, 0.55)';
        ctx.lineWidth = c.width + 6;
        ctx.lineCap = 'round';
        this.polyline(c.surface);
        ctx.stroke();
      }
    }
    if (o.highlightNode) {
      const h = o.highlightNode;
      ctx.strokeStyle = h.ok ? 'rgba(47, 128, 237, 0.85)' : 'rgba(232, 72, 63, 0.85)';
      ctx.lineWidth = 2.5 / this.camera.zoom;
      ctx.setLineDash([5 / this.camera.zoom, 4 / this.camera.zoom]);
      ctx.beginPath();
      ctx.arc(h.pos.x, h.pos.y, h.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Обводка выбранной машины или поезда (поезд — по середине состава).
    const sel = o.selection;
    if (sel?.type === 'junction') {
      const hover = o.mainHover?.node === sel.id ? o.mainHover : null;
      this.drawJunctionPaths(
        game,
        sel.id,
        o.laneEdit?.node === sel.id ? o.laneEdit : null,
        game.junctionMain(sel.id, hover ? hover.mainPair : undefined),
        o.phaseEdit?.node === sel.id ? o.phaseEdit : null,
      );
      if (o.walkEdit?.node === sel.id) this.drawWalkToggles(o.walkEdit);
    }
    const sim = sel?.type === 'vehicle' ? game.traffic.vehicles.get(sel.simId) : undefined;
    if (sel?.type === 'parkedCar') {
      const look = game.parkedCars.get(sel.id)?.look;
      const trip = game.parkedCars.trip(sel.id);
      if (trip) this.drawTripAhead(trip.pts, '#2f80ed', { pos: trip.goal, r: 5 });
      if (look) this.drawSelectRing(look.pos.x - look.dir.x * look.length / 2, look.pos.y - look.dir.y * look.length / 2, look.length * 0.9 + 3);
    }
    if (sim) this.drawVehicleTrip(game, sim.id);
    if (sim) this.drawSelectRing(sim.pos.x - (sim.dir.x * sim.length) / 2, sim.pos.y - (sim.dir.y * sim.length) / 2, sim.length * 0.9 + 3);
    // Машину компании обводит её линия (drawLinePath), если та на карте.
    else if (selFleet && selFleet.lineId !== shownLine) this.drawFleetSelected(game, selFleet);
    if (sel?.type === 'crew') this.drawCrewSelected(game, sel.id);
    // Выбрана база — пути её бригад в дороге; проект — бригад, что едут к нему (куда и откуда едут).
    if (sel?.type === 'base' || sel?.type === 'project') {
      for (const b of game.construction.crews.brigades.values()) {
        if (sel.type === 'base' ? b.base !== sel.id : b.project !== sel.id || b.state !== 'going') continue;
        if (b.state === 'going' || b.state === 'back') this.drawCrewRoute(game, b.id, sel.type === 'base' ? 'goal' : 'none');
      }
    }
    if (sel?.type === 'workTrain') this.drawWorkTrainSelected(game, sel.id);
  }

  /**
   * Выбранная бригада: её маршрут — куда едет (drawCrewRoute), и кольцо у каждой её машины — в потоке, вдоль стройки,
   * ждущих колонну и на работе у края (Game.crewSpots: машины бригады вне потока — те же, что рисуются, Crews.carsAt).
   */
  private drawCrewSelected(game: Game, id: number): void {
    this.drawCrewRoute(game, id, 'goal');
    for (const s of game.crewSpots(id)) this.drawSelectRing(s.pos.x, s.pos.y, s.r);
  }

  /**
   * Маршрут бригады id (Game.brigadeRoute): оранжевой линией со стрелками от головной машины по дорогам до узла
   * подъезда и вдоль стройки до края работ (домой — до базы); mark 'goal' — цель кольцом (край работ, база), 'none' —
   * без кольца (выбран сам проект: он и так подсвечен).
   */
  private drawCrewRoute(game: Game, id: number, mark: 'goal' | 'none'): void {
    const route = game.brigadeRoute(id);
    if (!route) return;
    const base = route.home ? game.construction.crews.bases.get(game.construction.crews.brigades.get(id)?.base ?? -1) : undefined;
    const goal = mark === 'none' ? null : { pos: route.goal, r: base ? footprintRadius(base.fp) : 6 };
    this.drawTripAhead(route.pts, CREW_ROUTE_COLOR, goal);
  }

  /** Обводка выбранной машины компании: на посту автостанции — рамкой по посту, в пути и у остановки — кольцом. */
  private drawFleetSelected(game: Game, fleet: FleetVehicle): void {
    const spot = game.fleetSpot(fleet);
    if (spot?.box && spot.box.w * this.camera.zoom >= 6) this.drawBayMark(spot.box, 1 / this.camera.zoom, '#2f80ed');
    // Станцию, где её не видно, обводит кольцо цвета линии.
    else if (spot && !spot.station) this.drawSelectRing(spot.pos.x, spot.pos.y, spot.r);
  }

  private drawSelectRing(x: number, y: number, r: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = '#2f80ed';
    ctx.lineWidth = 2 / this.camera.zoom;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * Предпросмотр перестройки: будущая дорога поверх старой на зелёной подложке —
   * новая ширина, разметка полос и кромок, у односторонней — стрелки направления.
   */
  /** Проект: заливка участков, которых не видно дорогой, пунктир кромок и оси, узлы квадратиками. */
  private drawProject(p: NonNullable<ToolOverlay['project']>): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    // Площадки перекрёстков — под участками: асфальт со скруглёнными углами, бордюры углов пунктиром, как кромки
    // участков, обрезы подъездов (стоп-линии) — сплошной чертой.
    for (const pl of p.plates ?? []) {
      ctx.fillStyle = pl.ok ? 'rgba(47,128,237,0.18)' : 'rgba(232,72,63,0.35)';
      this.polyline(pl.poly);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = pl.ok ? '#2f80ed' : '#e8483f';
      ctx.lineWidth = (pl.ok ? 1.6 : 2.4) / z;
      ctx.setLineDash([7 / z, 5 / z]);
      for (const curb of pl.curbs) {
        this.polyline(curb);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineWidth = 2.4 / z;
      for (const [a, b] of pl.cuts) {
        this.polyline([a, b]);
        ctx.stroke();
      }
    }
    for (const s of p.segs) {
      const lut = new CurveLUT(s.curve);
      const blue = s.draft ? 'rgba(47,128,237,0.6)' : '#2f80ed';
      if (s.fill) {
        ctx.strokeStyle = s.ok ? 'rgba(47,128,237,0.18)' : 'rgba(232,72,63,0.35)';
        ctx.lineWidth = s.half * 2;
        this.polyline(lut.points);
        ctx.stroke();
      }
      ctx.strokeStyle = s.ok ? blue : '#e8483f';
      ctx.lineWidth = (s.ok ? 1.6 : 2.4) / z;
      ctx.setLineDash([7 / z, 5 / z]);
      for (const off of [-s.half, s.half]) {
        this.polyline(lut.offsetPolyline(off, 0, lut.length, 3));
        ctx.stroke();
      }
      ctx.lineWidth = 1 / z;
      ctx.setLineDash([2 / z, 6 / z]);
      this.polyline(lut.points);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Знаки скорости перед поворотами — как у построенной дороги: справа по ходу, у кромки.
    if (z >= 0.45) {
      const r = Math.max(3.2, 9 / z);
      ctx.save();
      this.signText(r);
      for (const s of p.signs ?? []) this.limitSign(add(s.pos, scale(rightNormal(s.dir), s.side - ROAD_MARGIN + 3 + r)), r, s.kmh, 'project');
      ctx.restore();
    }
    // Узлы проекта — после перьев (drawOverlay), чтобы линии перьев их не перечёркивали.
  }

  /**
   * Узел, за который тянут: белый квадрат с толстой тёмной обводкой — крупнее перьев (голубых кружков на
   * линиях-ручках), чтобы их не путать; под курсором — ещё крупнее, tip — откуда ведём проект (синий).
   * color — обводка не по умолчанию (красная — этот узел не двигается).
   */
  private nodeMark(p: Vec, o: { hot?: boolean; tip?: boolean; color?: string } = {}): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const r = (o.hot ? 9 : 7) / z;
    ctx.fillStyle = o.tip ? '#2f80ed' : o.hot ? '#e3ecf8' : '#ffffff';
    ctx.strokeStyle = o.color ?? '#2b3038';
    ctx.lineWidth = 2.6 / z;
    ctx.beginPath();
    ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
    ctx.fill();
    ctx.stroke();
  }

  /** Что строим: изменённые полотна сети предпросмотра — зелёной (можно) или красной (нельзя) подсветкой. */
  /**
   * Подсветка того, что строим: зелёным — можно, красным — нельзя. layer — слой высоты: мост подсвечивается
   * поверх своего полотна (с земли его закрыло бы полотно), земля и тоннель — в слое земли.
   */
  private drawRoadPreview(p: NonNullable<ToolOverlay['roads']>, layer = 0): void {
    const color = p.project ? 'rgba(47,128,237,0.3)' : p.ok ? 'rgba(46,157,87,0.28)' : 'rgba(232,72,63,0.4)';
    for (const id of p.changed) {
      const c = p.net.corridors.get(id);
      if (!c) continue;
      const la = p.net.node(c.a).level;
      const lb = p.net.node(c.b).level;
      if (Math.max(0, layerOf(Math.min(la, lb), Math.max(la, lb))) === layer) this.tintCorridor(p.net, id, color);
    }
  }

  /**
   * «Лесенка» на превью дороги, которой мешает уклон: поперёк полотна — где ось пересекает изолинии (через шаг
   * промежуточных, fineContourStep), с высотой сбоку; ступеньки чаще, чем можно дороге, — красные. Видно, где и
   * насколько круто, даже под заливкой превью. Только полотна на земле: у моста и тоннеля земля не в счёт.
   */
  private drawGradeRungs(game: Game, o: ToolOverlay): void {
    const t = game.terrain;
    if (!t.hasRelief) return;
    // Оси, где рисовать: полотна превью обычной стройки (на земле) и участки проекта, что не выходят.
    const axes: { lut: CurveLUT; edges: (s: number) => [number, number] }[] = [];
    if (o.roads) {
      const net = o.roads.net;
      for (const id of o.roads.changed) {
        const c = net.corridors.get(id);
        if (c && net.node(c.a).level === 0 && net.node(c.b).level === 0) axes.push({ lut: c.lut, edges: (s) => edgesAt(c, s) ?? [-LANE_W, LANE_W] });
      }
    }
    for (const seg of o.project?.segs ?? []) if (!seg.ok) axes.push({ lut: new CurveLUT(seg.curve), edges: () => [-seg.half, seg.half] });
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const step = fineContourStep(t.contourStep);
    const ds = 2;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.font = `600 ${10 / z}px sans-serif`;
    ctx.textBaseline = 'middle';
    for (const { lut, edges } of axes) {
      const n = Math.max(2, Math.ceil(lut.length / ds) + 1);
      const d = lut.length / (n - 1);
      const alts = Array.from({ length: n }, (_, i) => t.altitudeAt(lut.pointAt(i * d)));
      const off = (s: number, by: number) => add(lut.pointAt(s), scale(rightNormal(lut.tangentAt(s)), by));
      for (const r of gradeRungs(alts, d, step, GRADE.road)) {
        const e = edges(r.s);
        const a = off(r.s, e[0] - 2);
        const b = off(r.s, e[1] + 2);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineWidth = (r.steep ? 4.5 : 3.5) / z;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.stroke();
        ctx.lineWidth = (r.steep ? 2.5 : 1.5) / z;
        ctx.strokeStyle = r.steep ? '#c62f26' : 'rgba(70, 56, 30, 0.9)';
        ctx.stroke();
        // Высота — за правой кромкой, по ходу ступеньки.
        const q = off(r.s, e[1] + 2 + 4 / z);
        const text = contourLabel(r.alt);
        // Подпись — от полотна наружу: кромка левее оси — текст влево от точки.
        ctx.textAlign = q.x < b.x ? 'right' : 'left';
        ctx.lineWidth = 3 / z;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.strokeText(text, q.x, q.y);
        ctx.fillStyle = r.steep ? '#b3261e' : 'rgba(70, 56, 30, 0.95)';
        ctx.fillText(text, q.x, q.y);
      }
    }
    ctx.restore();
  }

  /** Полупрозрачная заливка асфальта полотна. */
  /** Одна полоса полотна — заливкой по её ширине (с отгонами). */
  private tintLane(net: LaneNet, id: number, i: number, color: string): void {
    const c = net.corridors.get(id);
    const lane = c?.lanes[i];
    if (!c || !lane) return;
    const left: Vec[] = [];
    const right: Vec[] = [];
    for (const s of axisStations(c, 0, c.length, 4)) {
      const b = laneBand(c, lane, s);
      if (!b) continue;
      // У моста — поднята вместе с полотном (как tintCorridor).
      const d = deckLift(net, c, s);
      left.push(add(pointOff(c, s, b[0]), d));
      right.push(add(pointOff(c, s, b[1]), d));
    }
    if (left.length < 2) return;
    this.ctx.fillStyle = color;
    this.polyline([...left, ...right.reverse()]);
    this.ctx.closePath();
    this.ctx.fill();
  }

  private tintCorridor(net: LaneNet, id: number, color: string): void {
    const c = net.corridors.get(id);
    if (!c) return;
    const left: Vec[] = [];
    const right: Vec[] = [];
    // У моста — поднята вместе с полотном (как его рисует LaneRenderer).
    const raised = Math.max(net.node(c.a).level, net.node(c.b).level) > 0;
    for (const s of axisStations(c, 0, c.length, 5)) {
      const e = asphaltEdgesAt(c, s);
      if (!e) continue;
      const d = raised ? bridgeLook(deckAlong(net, c, s)).lift : null;
      const up = (p: Vec) => (d ? add(p, d) : p);
      left.push(up(pointOff(c, s, e[0])));
      right.push(up(pointOff(c, s, e[1])));
    }
    if (left.length < 2) return;
    const ctx = this.ctx;
    ctx.fillStyle = color;
    this.polyline([...left, ...right.reverse()]);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Выбранный перекрёсток: разрешённые проезды — синие линии со стрелками, запрещённые — красный пунктир.
   * При настройке полос выбранная полоса въезда и её связи — зелёные, остальные проезды бледнее.
   * main — главная дорога (или та, на которую навели в карточке): жёлтая полоса и знаки у въездов.
   * phase — правка фазы светофора: проезды цветом по фазе (drawPhasePaths) вместо синих.
   */
  private drawJunctionPaths(
    game: Game,
    nodeId: number,
    edit: ToolOverlay['laneEdit'],
    main: [number, number] | null,
    phase: ToolOverlay['phaseEdit'] = null,
  ): void {
    const ctx = this.ctx;
    const net = game.roads.net;
    const g = game.roads.graph;
    const n = net.nodes.get(nodeId);
    if (!n) return;
    const z = this.camera.zoom;
    const all = (g.inLinks.get(nodeId) ?? []).flatMap((l) => l.lanes.flatMap((lane) => g.movesFrom.get(lane.id) ?? [])).filter((m) => m.node === nodeId);
    const radius = Math.max(12, ...all.map((m) => dist(n.pos, m.points[0])));
    if (main) this.drawMainBand(net, n, main);
    ctx.strokeStyle = phase ? 'rgba(47,128,237,0.85)' : 'rgba(47,128,237,0.55)';
    ctx.lineWidth = 3 / z;
    ctx.beginPath();
    ctx.arc(n.pos.x, n.pos.y, radius + 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineCap = 'round';
    if (phase) this.drawPhasePaths(g, n.pos, all, phase, radius + 10);
    const from = edit?.from ?? null;
    const active = from ? edit?.ends.find((e) => e.kind === 'in' && e.seg === from.seg && e.i === from.i) : undefined;
    const mine = all.filter((m) => m.inLane === active?.lane);
    for (const m of phase ? [] : [...all.filter((x) => !mine.includes(x)), ...mine]) {
      const bright = mine.includes(m);
      const color = bright ? '#27ae60' : '#2f80ed';
      ctx.globalAlpha = active && !bright ? 0.25 : 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = (bright ? 3 : 1.6) / z;
      this.polyline(m.points);
      ctx.stroke();
      const end = m.points[m.points.length - 1];
      const prev = m.points[m.points.length - 2] ?? m.points[0];
      const d = { x: end.x - prev.x, y: end.y - prev.y };
      const l = Math.hypot(d.x, d.y) || 1;
      const u = { x: d.x / l, y: d.y / l };
      const s = (bright ? 4.5 : 3) / z;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(end.x + u.x * s, end.y + u.y * s);
      ctx.lineTo(end.x - u.x * s - u.y * s, end.y - u.y * s + u.x * s);
      ctx.lineTo(end.x - u.x * s + u.y * s, end.y - u.y * s - u.x * s);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (edit) this.drawLaneMarks(game, edit, active);
    // Запрещённые повороты: от подъезда к выезду.
    ctx.strokeStyle = 'rgba(232,72,63,0.85)';
    ctx.lineWidth = 2 / z;
    ctx.setLineDash([4 / z, 4 / z]);
    const ends = net.ends(n);
    for (const key of n.bans ?? []) {
      const [from, to] = key.split('>').map(Number);
      const ef = ends.find((e) => e.corridor.id === from);
      const et = ends.find((e) => e.corridor.id === to);
      if (!ef || !et) continue;
      const a = add(n.pos, scale(ef.away, radius + 8));
      const b = add(n.pos, scale(et.away, radius + 8));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(n.pos.x, n.pos.y, b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (main) this.drawPrioritySigns(net, n, main, new Set((g.inLinks.get(nodeId) ?? []).map((l) => l.corridor)), radius);
  }

  /**
   * Правка фазы светофора: проезды через перекрёсток по фазе — зелёный (едет), зелёный пунктир (уступает встречным),
   * белый (красный, зелёный дать можно), бледный красный пунктир (нельзя: пересечёт зелёный), красный (конфликт).
   * Под курсором — толще, с ореолом; у запретного под курсором и при отказе — и зелёные, которые он пересечёт, красным.
   * Над кругом перекрёстка (ring — его радиус) — номер фазы.
   */
  private drawPhasePaths(g: LaneGraph, center: Vec, all: GMove[], pe: NonNullable<ToolOverlay['phaseEdit']>, ring: number): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const blink = Math.floor(performance.now() / 180) % 2 === 0;
    const hot = pe.hover ? pe.states.get(pe.hover) : undefined;
    const against = new Set(hot?.look === 'blocked' ? hot.with : []);
    const flash = new Set(pe.flash);
    // Красные и белые — снизу, зелёные — поверх, конфликт и проезд под курсором — сверху.
    const order: Record<TurnLook, number> = { free: 0, blocked: 0, go: 1, yield: 1, clash: 2 };
    const rank = (t: { turn: string; look: TurnLook }) => order[t.look] + (t.turn === pe.hover ? 5 : 0);
    const items = all.map((m) => ({ m, turn: g.turnOf(m), look: pe.states.get(g.turnOf(m))?.look ?? ('free' as TurnLook) })).sort((a, b) => rank(a) - rank(b));
    ctx.lineCap = 'round';
    for (const { m, turn, look } of items) {
      const hover = turn === pe.hover;
      let color = '#ffffff';
      let width = 1.8;
      let dash: number[] = [];
      let alpha = 0.85;
      if (look === 'go' || look === 'yield' || look === 'clash') {
        color = look === 'clash' ? '#e8483f' : '#27ae60';
        width = 3.2;
        alpha = 1;
        if (look === 'yield') dash = [6, 4];
      } else if (look === 'blocked') {
        color = '#e8483f';
        width = 1.6;
        dash = [3, 3];
        alpha = 0.6;
      }
      if (against.has(turn) || (flash.has(turn) && blink)) {
        color = '#e8483f';
        alpha = 1;
      }
      if (hover) {
        width += 1.6;
        alpha = 1;
        // Ореол: видно, по какому проезду придётся клик (у красного — каким станет: зелёным, если можно).
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = look === 'free' ? '#27ae60' : look === 'blocked' ? '#e8483f' : '#ffffff';
        ctx.lineWidth = (width + 5) / z;
        this.polyline(m.points);
        ctx.stroke();
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width / z;
      ctx.setLineDash(dash.map((d) => d / z));
      this.polyline(m.points);
      ctx.stroke();
      ctx.setLineDash([]);
      this.pathArrow(m.points, (width + 2.2) / z, color);
    }
    ctx.globalAlpha = 1;
    // Номер фазы — плашкой над кругом перекрёстка, синей, как выбранная плитка в карточке.
    const text = `Фаза ${pe.i + 1}`;
    ctx.font = `700 ${12 / z}px sans-serif`;
    const w = ctx.measureText(text).width + 14 / z;
    const h = 20 / z;
    const x = center.x - w / 2;
    const y = center.y - ring - h - 4 / z;
    ctx.fillStyle = '#2f80ed';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, center.x, y + h / 2 + 0.5 / z);
  }

  /** Стрелка на конце пути — по последнему отрезку, размером s. */
  private pathArrow(pts: Vec[], s: number, color: string): void {
    const ctx = this.ctx;
    const end = pts[pts.length - 1];
    const prev = pts[pts.length - 2] ?? pts[0];
    const l = Math.hypot(end.x - prev.x, end.y - prev.y) || 1;
    const u = { x: (end.x - prev.x) / l, y: (end.y - prev.y) / l };
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(end.x + u.x * s, end.y + u.y * s);
    ctx.lineTo(end.x - u.x * s - u.y * s, end.y - u.y * s + u.x * s);
    ctx.lineTo(end.x - u.x * s + u.y * s, end.y - u.y * s - u.x * s);
    ctx.fill();
  }

  /**
   * Главная дорога через перекрёсток — одна полупрозрачная жёлтая лента по середине полотна:
   * плечо A от дальнего конца к краю узла, через узел — кривая с касательными по плечам, плечо B наружу.
   * Ширина — ровно по полотну (в узле плавно переходит от плеча к плечу), к концам лента тает.
   */
  private drawMainBand(net: LaneNet, n: LaneNode, main: [number, number]): void {
    const ctx = this.ctx;
    const ends = net.ends(n);
    const arms = main.map((id) => ends.find((e) => e.corridor.id === id));
    if (!arms[0] || !arms[1]) return;
    const cuts = this.lanes.cutsOf(net);
    // Плечо от края узла наружу (до MAIN_REACH и не заходя в узел на том конце): середина и полуширина полотна.
    const arm = (e: CorridorEnd) => {
      const c = e.corridor;
      const [ca, cb] = cuts.get(c.id) ?? [0, 0];
      const [near, other] = e.end === 'a' ? [ca, cb] : [cb, ca];
      const far = Math.max(near, Math.min(MAIN_REACH, c.length - other));
      const ss = e.end === 'a' ? axisStations(c, near, far, 4) : axisStations(c, c.length - far, c.length - near, 4).reverse();
      const pts: { p: Vec; h: number }[] = [];
      for (const s of ss) {
        const ed = edgesAt(c, s);
        if (ed) pts.push({ p: pointOff(c, s, (ed[0] + ed[1]) / 2), h: (ed[1] - ed[0]) / 2 });
      }
      // Направление от узла на краю узла.
      const away = scale(c.lut.tangentAt(e.end === 'a' ? near : c.length - near), e.end === 'a' ? 1 : -1);
      return { pts, away };
    };
    const A = arm(arms[0]);
    const B = arm(arms[1]);
    if (A.pts.length < 2 || B.pts.length < 2) return;
    // Через узел — кривая Безье между краями плеч, касательные — по плечам; ширина меняется плавно.
    const a0 = A.pts[0];
    const b0 = B.pts[0];
    const k = dist(a0.p, b0.p) * 0.45;
    const c1 = sub(a0.p, scale(A.away, k));
    const c2 = sub(b0.p, scale(B.away, k));
    const through: { p: Vec; h: number }[] = [];
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      through.push({ p: cubicBezier(a0.p, c1, c2, b0.p, t), h: a0.h + (b0.h - a0.h) * t * t * (3 - 2 * t) });
    }
    const line = [...[...A.pts].reverse(), ...through, ...B.pts].filter((q, i, all) => i === 0 || dist(q.p, all[i - 1].p) > 0.05);
    if (line.length < 2) return;
    // Края ленты — на полуширину вправо и влево от середины по ходу ленты.
    const right: Vec[] = [];
    const left: Vec[] = [];
    line.forEach((q, i) => {
      const d = sub(line[Math.min(line.length - 1, i + 1)].p, line[Math.max(0, i - 1)].p);
      const nrm = rightNormal(scale(d, 1 / (Math.hypot(d.x, d.y) || 1)));
      right.push(add(q.p, scale(nrm, q.h)));
      left.push(sub(q.p, scale(nrm, q.h)));
    });
    // Тает от узла: до середины — ровно, к ближнему из дальних концов — до нуля.
    const reach = Math.max(40, Math.min(MAIN_REACH, dist(n.pos, line[0].p), dist(n.pos, line[line.length - 1].p)));
    const grad = ctx.createRadialGradient(n.pos.x, n.pos.y, 0, n.pos.x, n.pos.y, reach);
    grad.addColorStop(0, 'rgba(255,196,0,0.42)');
    grad.addColorStop(0.5, 'rgba(255,196,0,0.42)');
    grad.addColorStop(1, 'rgba(255,196,0,0)');
    ctx.fillStyle = grad;
    this.polyline([...right, ...left.reverse()]);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Знаки у въездов в перекрёсток, справа по ходу: жёлтый ромб «Главная дорога» — у главных плеч,
   * треугольник «Уступи дорогу» — у второстепенных. Только там, где в перекрёсток въезжают (inArms).
   */
  private drawPrioritySigns(net: LaneNet, n: LaneNode, main: [number, number], inArms: Set<number>, radius: number): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    // Издалека — 8 пикселей, вблизи растёт вместе с дорогой.
    const k = Math.max(8 / z, LANE_W * 0.3);
    ctx.lineJoin = 'round';
    for (const e of net.ends(n)) {
      const c = e.corridor;
      if (!inArms.has(c.id)) continue;
      const d = Math.min(c.length, radius + k * 1.5);
      const s = e.end === 'a' ? d : c.length - d;
      const ed = edgesAt(c, s) ?? [-LANE_W, LANE_W];
      // Справа по ходу въезда: у конца a едут против оси (левая кромка), у конца b — по оси (правая).
      const gap = corridorMargin(c) + k * 1.3;
      const p = pointOff(c, s, e.end === 'a' ? ed[0] - gap : ed[1] + gap);
      if (main.includes(c.id)) {
        // 2.1 «Главная дорога»: белый ромб, в нём жёлтый.
        const diamond = (r: number) => {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - r);
          ctx.lineTo(p.x + r, p.y);
          ctx.lineTo(p.x, p.y + r);
          ctx.lineTo(p.x - r, p.y);
          ctx.closePath();
        };
        diamond(k);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#1f2933';
        ctx.lineWidth = 1.2 / z;
        ctx.stroke();
        diamond(k * 0.6);
        ctx.fillStyle = '#f5b800';
        ctx.fill();
        ctx.lineWidth = 0.8 / z;
        ctx.stroke();
      } else {
        // 2.4 «Уступи дорогу»: белый треугольник вершиной вниз в красной кайме.
        const tri = (r: number) => {
          ctx.beginPath();
          ctx.moveTo(p.x - r, p.y - r * 0.6);
          ctx.lineTo(p.x + r, p.y - r * 0.6);
          ctx.lineTo(p.x, p.y + r * 1.05);
          ctx.closePath();
        };
        tri(k * 1.05);
        ctx.fillStyle = '#e8483f';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2 / z;
        ctx.stroke();
        tri(k * 0.55);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }
    }
  }

  /**
   * Значки пешеходных переходов в «Перекрёстке» — знак 5.19: переход есть — как есть, нет — серый, перечёркнут красным,
   * а где ляжет зебра — контуром полосок; «само» (по городу, игрок не трогал) — пунктир вокруг; под курсором — крупнее.
   */
  private drawWalkToggles(edit: NonNullable<ToolOverlay['walkEdit']>): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    // Стёртые переходы — контуром полосок зебры (куда ляжет, если нарисовать).
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 1 / z;
    ctx.setLineDash([2 / z, 2 / z]);
    ctx.beginPath();
    for (const t of edit.toggles) {
      for (const q of t.stripes ?? []) {
        ctx.moveTo(q[0].x, q[0].y);
        for (let i = 1; i < q.length; i++) ctx.lineTo(q[i].x, q[i].y);
        ctx.closePath();
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Знак «Пешеходный переход» у бордюра на конце зебры, ровно на экране (src/render/walkSign.ts).
    for (const t of edit.toggles) drawWalkSign(ctx, t.pos, walkSignSize(z) * (t.corridor === edit.hover ? 1.15 : 1), t, z);
  }

  /** На дальнем плане фигуры меньше пикселя. Пешеходы в тоннеле скрыты между лестницами. */
  private drawPedestrians(game: Game, view: ReturnType<Renderer['view']>): void {
    const z = this.camera.zoom;
    if (z < 1.2 || !game.pedestrians.on) return;
    const ctx = this.ctx;
    const COATS = ['#d9534f', '#3a6fb0', '#e8b83a', '#4c9a5b', '#7d5ba6', '#e07b39', '#30343a', '#e6e2d8'];
    ctx.strokeStyle = 'rgba(30, 30, 30, 0.6)';
    ctx.lineWidth = 0.2;
    for (const p of game.pedestrians.visible(game.time, view)) {
      ctx.save();
      ctx.translate(p.pos.x, p.pos.y);
      ctx.rotate(p.heading);
      if (z >= 3) {
        const stride = p.walking ? 0.48 * Math.sin(game.time * 8 + p.seed) : 0;
        ctx.fillStyle = '#454346';
        ctx.fillRect(stride - 0.35, -0.6, 0.85, 0.42);
        ctx.fillRect(-stride - 0.35, 0.18, 0.85, 0.42);
      }
      ctx.fillStyle = COATS[Math.floor(hash(p.seed, 7) * COATS.length)];
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.65, 1, 0, 0, Math.PI * 2);
      ctx.fill();
      if (z >= 2) {
        ctx.stroke();
        ctx.fillStyle = hash(p.seed, 9) < 0.3 ? '#4a3626' : '#e9c3a0';
        ctx.beginPath();
        ctx.arc(0.18, 0, 0.49, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /**
   * Метки полос для настройки связей. Въезд — белый кружок с тёмной обводкой (настроенный — с зелёной),
   * выезд — оранжевый; выезд, связанный с выбранной полосой, — зелёный, недоступный ей — бледный.
   * Треугольник внутри показывает направление движения по полосе.
   */
  private drawLaneMarks(game: Game, edit: NonNullable<ToolOverlay['laneEdit']>, active: LaneEnd | undefined): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const r = laneMarkRadius(z);
    const linked = new Set(active ? (game.roads.graph.movesFrom.get(active.lane) ?? []).map((m) => m.outLane) : []);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
    for (const e of edit.ends) {
      const isActive = e.lane === active?.lane;
      const hover = e.lane === edit.hover?.lane;
      const rr = r * (isActive ? 1.3 : 1) * (hover ? 1.25 : 1);
      ctx.globalAlpha = active && e.kind === 'out' && !active.exits.includes(e.seg) ? 0.3 : 1;
      let fill: string;
      let ring: string;
      let mark: string;
      if (e.kind === 'in') {
        fill = isActive ? '#27ae60' : '#ffffff';
        ring = e.custom || isActive ? '#1e8c4e' : '#1f2933';
        mark = isActive ? '#ffffff' : '#1f2933';
      } else {
        fill = linked.has(e.lane) ? '#27ae60' : '#f2994a';
        ring = '#ffffff';
        mark = '#ffffff';
      }
      ctx.fillStyle = fill;
      ctx.strokeStyle = ring;
      ctx.lineWidth = (e.custom ? 2.4 : 1.4) / z;
      ctx.beginPath();
      ctx.arc(e.pos.x, e.pos.y, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const s = rr * 0.55;
      const d = e.dir;
      ctx.fillStyle = mark;
      ctx.beginPath();
      ctx.moveTo(e.pos.x + d.x * s, e.pos.y + d.y * s);
      ctx.lineTo(e.pos.x - d.x * s * 0.7 - d.y * s * 0.8, e.pos.y - d.y * s * 0.7 + d.x * s * 0.8);
      ctx.lineTo(e.pos.x - d.x * s * 0.7 + d.y * s * 0.8, e.pos.y - d.y * s * 0.7 - d.x * s * 0.8);
      ctx.fill();
      if (isActive) {
        ctx.strokeStyle = `rgba(39, 174, 96, ${0.35 + pulse * 0.45})`;
        ctx.lineWidth = 2 / z;
        ctx.beginPath();
        ctx.arc(e.pos.x, e.pos.y, rr + (3 + pulse * 3) / z, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Пунктиры от выбранного предприятия или города к ближайшим партнёрам по цепочке. */
  private drawPartners(game: Game, sel: Selection | null): void {
    if (sel?.type === 'deposit') {
      // Выбранное месторождение — синим кольцом; пунктиры — к тем, кто примет его сырьё (как у добычи на нём).
      const d = game.enterprises.deposit(sel.id);
      if (!d || d.used !== undefined) return;
      const ctx = this.ctx;
      const z = this.camera.zoom;
      ctx.strokeStyle = '#2f80ed';
      ctx.lineWidth = 3 / z;
      ctx.beginPath();
      ctx.arc(d.center.x, d.center.y, depositRadius(d) + 10 / z, 0, Math.PI * 2);
      ctx.stroke();
      this.drawPartnerLines(d.center, game.partners(game.enterprises.depositProbe(d), 1));
      return;
    }
    if (!sel || (sel.type !== 'industry' && sel.type !== 'town')) return;
    const target = sel.type === 'industry' ? game.industries.find((i) => i.id === sel.id) : game.towns.find((t) => t.id === sel.id);
    if (!target) return;
    this.drawPartnerLines('fp' in target ? target.fp.center : target.center, game.partners(target));
  }

  /**
   * Предпросмотр инструмента «Предприятие»: месторождения выбранного вида — пульсирующими кольцами, черта городов —
   * пунктирными кругами (зелёный — есть место, серый — нет), у курсора — участок, зона вреда, пунктиры к партнёрам
   * и к свободным месторождениям сырья (серым).
   */
  private drawIndustryPreview(game: Game, pv: NonNullable<ToolOverlay['industry']>): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const kind = pv.kind;
    const info = kind ? INDUSTRY_TYPES[kind] : null;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
    this.moving = true;
    // Черта городов: где завод станет городским (по местам).
    for (const t of game.towns) {
      const free = townSlots(t) > townIndustries(t, game.towns, game.industries).length;
      ctx.setLineDash([12 / z, 8 / z]);
      ctx.strokeStyle = free ? 'rgba(46,157,87,0.75)' : 'rgba(110,116,125,0.6)';
      ctx.lineWidth = 2 / z;
      ctx.beginPath();
      ctx.arc(t.center.x, t.center.y, townEdge(t), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Месторождения выбранной добычи — ярко, кольцом и значком; у завода — его сырьё.
    const want = info ? (info.accepts.length ? info.accepts : [info.produces]) : [];
    for (const d of game.enterprises.deposits) {
      if (d.used !== undefined) continue;
      const cargo = INDUSTRY_TYPES[d.kind].produces;
      if (!want.includes(cargo)) continue;
      const own = info && !info.accepts.length;
      ctx.strokeStyle = own ? `rgba(47,128,237,${0.55 + 0.45 * pulse})` : 'rgba(110,116,125,0.7)';
      ctx.lineWidth = (own ? 3 : 2) / z;
      ctx.beginPath();
      ctx.arc(d.center.x, d.center.y, depositRadius(d) + 10 / z, 0, Math.PI * 2);
      ctx.stroke();
      this.icon(cargoImage(cargo), d.center, Math.max(18, 22 / z));
    }
    const plan = pv.plan;
    if (!plan?.fp || !kind || !info) return;
    drawHarmZone(ctx, kind, plan.fp, z);
    paintIndustrySite(ctx, info, plan.fp, plan.ok ? 'rgba(47,128,237,0.35)' : 'rgba(232,72,63,0.35)', plan.ok ? '#2f80ed' : '#e8483f', 2 / z);
    for (const id of plan.demolish) {
      const b = game.buildingById(id);
      if (b) this.drawFootprint(b.fp, 'rgba(232,72,63,0.45)');
    }
    // Пунктиры к ближайшим поставщикам сырья и получателям продукции — как у выбранного предприятия.
    const probe = { type: 'industry', id: -1, info, fp: plan.fp, name: '', stock: {}, output: 0, producedMonth: 0, producedLast: 0, prodAcc: 0 } as Industry;
    this.drawPartnerLines(plan.fp.center, game.partners(probe, 1));
    // Сырья нет на карте — к ближайшему свободному месторождению серым пунктиром.
    for (const c of info.accepts) {
      if (game.industries.some((i) => !i.ruin && i.info.produces === c)) continue;
      const near = game.enterprises.deposits
        .filter((d) => d.used === undefined && INDUSTRY_TYPES[d.kind].produces === c)
        .sort((a, b) => dist(a.center, plan.fp!.center) - dist(b.center, plan.fp!.center))[0];
      if (!near) continue;
      ctx.setLineDash([8 / z, 8 / z]);
      ctx.strokeStyle = 'rgba(90,96,105,0.75)';
      ctx.lineWidth = 2.5 / z;
      ctx.beginPath();
      ctx.moveTo(near.center.x, near.center.y);
      ctx.lineTo(plan.fp.center.x, plan.fp.center.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Пунктиры со стрелками от точки from к партнёрам по цепочке (и от поставщиков к ней), с плашкой груза и км. */
  private drawPartnerLines(from: Vec, list: Partner[]): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    for (const p of list) {
      const color = CARGO[p.cargo].color;
      const [a, b] = p.direction === 'out' ? [from, p.pos] : [p.pos, from];
      const d = { x: b.x - a.x, y: b.y - a.y };
      const len = Math.hypot(d.x, d.y) || 1;
      const u = { x: d.x / len, y: d.y / len };
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 3.5 / z;
      ctx.setLineDash([14 / z, 9 / z]);
      ctx.beginPath();
      ctx.moveTo(a.x + u.x * 40, a.y + u.y * 40);
      ctx.lineTo(b.x - u.x * 60, b.y - u.y * 60);
      ctx.stroke();
      ctx.setLineDash([]);
      // Стрелка у получателя.
      const tip = { x: b.x - u.x * 50, y: b.y - u.y * 50 };
      const s = 12 / z;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - u.x * s * 1.6 - u.y * s, tip.y - u.y * s * 1.6 + u.x * s);
      ctx.lineTo(tip.x - u.x * s * 1.6 + u.y * s, tip.y - u.y * s * 1.6 - u.x * s);
      ctx.fill();
      ctx.globalAlpha = 1;
      // Посередине пунктира — плашка «что везём · сколько км», прямо на линии,
      // чтобы не казалось, что партнёр стоит здесь.
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      ctx.save();
      ctx.translate(mid.x, mid.y);
      ctx.scale(1 / z, 1 / z);
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const km = `${(p.distance * 0.0006).toFixed(1)} км`;
      const w = ctx.measureText(km).width + 30;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      rr(ctx, -w / 2, -10, w, 20, 10);
      ctx.fill();
      ctx.stroke();
      this.icon(cargoImage(p.cargo), { x: -w / 2 + 11, y: 0 }, 14);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#1f2933';
      ctx.fillText(km, -w / 2 + 21, 0.5);
      ctx.restore();
      // Сам партнёр — кольцом цвета груза, название — над ним (под ним уже своя подпись).
      ctx.save();
      ctx.translate(p.pos.x, p.pos.y);
      ctx.scale(1 / z, 1 / z);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 24, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineJoin = 'round';
      ctx.strokeText(p.name, 0, -36);
      ctx.fillStyle = '#1f2933';
      ctx.fillText(p.name, 0, -36);
      ctx.restore();
    }
  }

  /** Маршрут линии с её машинами; hover — машина под курсором в списке, selected — выбранная: их кольца — под значками груза. */
  private drawLinePath(game: Game, lineId: number, hover: number | null = null, selected?: FleetVehicle): void {
    const line = game.lines.get(lineId);
    if (!line) return;
    this.drawStopsRoute(game, line.stops, line.color, true, line);
    // Машины и поезда линии — поверх маршрута, иначе их не видно под цветной полосой.
    // Под каждой — кружок цвета линии постоянного экранного размера: видно и издалека.
    const z = this.camera.zoom;
    const own: VehicleLook[] = [];
    const trains = new Set<number>();
    const marks: LineMark[] = [];
    for (const vid of line.vehicles) {
      const fv = game.fleet.get(vid);
      if (!fv) continue;
      const cargo = fv.cargo && fv.amount > 0 ? fv.cargo : fv.passengers.some((p) => p.count > 0) ? 'passengers' : null;
      // На дороге или на заезде к посту.
      const sim = game.fleetLook(fv);
      if (sim) {
        own.push(sim);
        const pos = { x: sim.pos.x - (sim.dir.x * sim.length) / 2, y: sim.pos.y - (sim.dir.y * sim.length) / 2 };
        marks.push({ pos, dir: sim.dir, r: sim.length * 0.7 + 2, cargo, kind: sim.kind === 'bus' ? 'bus' : 'truck', color: sim.color, load: sim.load });
      }
      const train = game.fleetTrain(fv);
      if (train) {
        trains.add(train.id);
        const head = game.rail.pointAt(train, train.head - 6);
        if (head) marks.push({ pos: head.pos, dir: head.dir, r: 10, cargo, kind: train.kind, color: train.color, load: train.load });
      }
    }
    const ctx = this.ctx;
    const R = (m: LineMark) => Math.max(m.r, 12 / z);
    for (const m of marks) {
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 3 / z;
      ctx.beginPath();
      ctx.arc(m.pos.x, m.pos.y, R(m), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    this.drawVehicles(own, true);
    if (trains.size) this.drawTrains(this.trainCars(game, this.view()).filter((c) => trains.has(c.trainId)), true);
    // Издалека настоящая машина крошечная — рисуем внутри кружка её увеличенный значок.
    for (const m of marks) if (m.r < R(m) * 0.75) this.markGlyph(m, R(m));
    if (selected) this.drawFleetSelected(game, selected);
    if (hover !== null) this.drawFleetHover(game, hover, lineId);
    // Что везёт — значок сбоку от кружка, поверх колец подсветки и выбора.
    for (const m of marks) {
      const r = R(m);
      if (m.cargo) this.icon(cargoImage(m.cargo), { x: m.pos.x + r * 0.8, y: m.pos.y - r * 0.8 }, 14 / z);
    }
  }

  /** Значок транспорта линии по размеру кружка: кабина и кузов цвета груза, автобус с окнами, локомотив с вагоном. */
  private markGlyph(m: LineMark, r: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(m.pos.x, m.pos.y);
    ctx.rotate(Math.atan2(m.dir.y, m.dir.x));
    const L = r * 1.5;
    const W = r * 0.62;
    const x0 = -L / 2;
    const empty = '#f4efe6';
    ctx.lineWidth = r * 0.06;
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    const box = (x: number, w: number, fill: string) => {
      ctx.fillStyle = fill;
      rr(ctx, x, -W / 2, w, W, W * 0.18);
      ctx.fill();
      ctx.stroke();
    };
    if (m.kind === 'truck') {
      box(x0, L * 0.68, m.load ?? empty);
      box(x0 + L * 0.72, L * 0.28, m.color);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(x0 + L * 0.9, -W * 0.36, L * 0.06, W * 0.72);
    } else if (m.kind === 'bus') {
      box(x0, L, m.color);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      for (let i = 0; i < 4; i++) ctx.fillRect(x0 + L * (0.1 + i * 0.19), -W * 0.38, L * 0.12, W * 0.2);
      ctx.fillRect(x0 + L * 0.9, -W * 0.36, L * 0.06, W * 0.72);
    } else {
      // Вагон сзади — цвета груза (у пассажирского светлый с окнами), локомотив спереди.
      const wagon = m.kind === 'passenger' ? '#eef1f4' : (m.load ?? empty);
      box(x0, L * 0.46, wagon);
      if (m.kind === 'passenger') {
        ctx.fillStyle = 'rgba(60,80,100,0.6)';
        for (let i = 0; i < 3; i++) ctx.fillRect(x0 + L * (0.06 + i * 0.13), -W * 0.3, L * 0.08, W * 0.6);
      }
      box(x0 + L * 0.5, L * 0.5, m.color);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(x0 + L * 0.88, -W * 0.36, L * 0.06, W * 0.72);
    }
    ctx.restore();
  }

  /**
   * Маршрут по станциям: по реальным полосам, со стрелками направления.
   * Если между станциями нет дороги — красный пунктир напрямую.
   */
  private drawStopsRoute(game: Game, stops: number[], color: string, loop: boolean, line?: Line): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const legs = loop ? stops.length : stops.length - 1;
    for (let i = 0; i < legs; i++) {
      const fromId = stops[i];
      const toId = stops[(i + 1) % stops.length];
      // У линии — до выбранных путей ж/д станций.
      const pts = line ? game.linePolyline(line, i) : game.routePolyline(fromId, toId);
      if (!pts || pts.length < 2) {
        const a = game.stations.get(fromId);
        const b = game.stations.get(toId);
        if (!a || !b) continue;
        ctx.strokeStyle = 'rgba(232, 72, 63, 0.85)';
        ctx.lineWidth = 3 / z;
        ctx.setLineDash([10 / z, 8 / z]);
        ctx.beginPath();
        ctx.moveTo(a.fp.center.x, a.fp.center.y);
        ctx.lineTo(b.fp.center.x, b.fp.center.y);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      this.strokeRoute(pts, color);
    }
  }

  /** Маршрут полосой цвета color на белой подложке со стрелками направления движения — линии, поезда, машины. */
  private strokeRoute(pts: readonly Vec[], color: string): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 6.5 / z;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.polyline(pts);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4 / z;
    this.polyline(pts);
    ctx.stroke();
    // Стрелки направления движения через равные промежутки экрана.
    const spacing = 90 / z;
    let acc = spacing / 2;
    ctx.fillStyle = '#ffffff';
    for (let k = 1; k < pts.length; k++) {
      const p0 = pts[k - 1];
      const p1 = pts[k];
      const seg = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (seg < 1e-6) continue;
      const ux = (p1.x - p0.x) / seg;
      const uy = (p1.y - p0.y) / seg;
      while (acc <= seg) {
        const cx = p0.x + ux * acc;
        const cy = p0.y + uy * acc;
        const s = 3.2 / z;
        ctx.beginPath();
        ctx.moveTo(cx + ux * s * 1.4, cy + uy * s * 1.4);
        ctx.lineTo(cx - ux * s - uy * s, cy - uy * s + ux * s);
        ctx.lineTo(cx - ux * s + uy * s, cy - uy * s - ux * s);
        ctx.fill();
        acc += spacing;
      }
      acc -= seg;
    }
  }

  /**
   * Куда едет выбранное (строительный поезд, машина): маршрут от него до цели — полосой цвета color (strokeRoute) и
   * цель — пульсирующим кольцом радиуса r того же цвета. Маршрута нет (стоит, строит) — только цель.
   */
  private drawTripAhead(pts: readonly Vec[] | null, color: string, goal: { pos: Vec; r: number } | null): void {
    if (pts && pts.length > 1) this.strokeRoute(pts, color);
    if (!goal) return;
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 / z;
    ctx.beginPath();
    ctx.arc(goal.pos.x, goal.pos.y, 4 / z, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(goal.pos.x, goal.pos.y, goal.r + (8 + pulse * 6) / z, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * Выбранная машина жителя или спецмашина: её маршрут по полосам от неё до цели (Game.vehicleAhead — только для
   * выбранной) и цель — кольцом вокруг здания поездки. Спецмашина — цветом своей службы, машина жителя — синим.
   */
  private drawVehicleTrip(game: Game, simId: number): void {
    const manual = game.parkedCars.trip(simId);
    if (manual) { this.drawTripAhead(manual.pts, '#2f80ed', { pos: manual.goal, r: 5 }); return; }
    const ahead = game.vehicleAhead(simId);
    if (!ahead) return;
    const service = game.serviceOfSim(simId);
    const to = game.tripOf(simId)?.to;
    const goal = to ? { pos: to.fp.center, r: footprintRadius(to.fp) } : { pos: ahead.goal, r: 4 };
    this.drawTripAhead(ahead.pts, service ? SERVICES[service].color : '#2f80ed', goal);
  }

  /**
   * Выбранный строительный поезд: маршрут по путям до цели (WorkTrains.route) его цветом, цель — край работ проекта
   * или вокзал-депо при возврате, и кольцо вокруг состава (в пути — вагоны, на месте работ — техника у края).
   */
  private drawWorkTrainSelected(game: Game, id: number): void {
    const trains = game.construction.trains;
    const w = trains?.list.get(id);
    if (!trains || !w) return;
    const goal = trains.goal(w);
    const st = goal?.depot ? game.stations.get(w.depot) : undefined;
    // Строит у края работ — цель там же, где поезд: кольца цели не нужно.
    const here = w.train !== undefined && trains.drawnBySite(w.train);
    const mark = goal && !here ? { pos: st ? st.fp.center : goal.pos, r: st ? footprintRadius(st.fp) : 4 } : null;
    this.drawTripAhead(trains.route(w)?.pts ?? null, WORK_TRAIN.color, mark);
    const body = trains.body(w);
    if (body && body.length > 1) this.drawBodyOutline(body, 5 + 3 / this.camera.zoom);
  }

  /**
   * Обводка выбранного длинного состава (строительный поезд: вагоны в пути или техника вдоль края работ) — синей
   * рамкой вдоль него на half от оси, а не кругом: круг вокруг стройки в сотню метров ничего не выделяет.
   */
  private drawBodyOutline(pts: readonly Vec[], half: number): void {
    const ctx = this.ctx;
    const left: Vec[] = [];
    const right: Vec[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const d = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
      // Концы — на half дальше по оси: рамка охватывает и торцы.
      const ext = i === 0 ? -half : i === pts.length - 1 ? half : 0;
      const p = { x: pts[i].x + d.x * ext, y: pts[i].y + d.y * ext };
      left.push({ x: p.x - d.y * half, y: p.y + d.x * half });
      right.push({ x: p.x + d.y * half, y: p.y - d.x * half });
    }
    ctx.beginPath();
    left.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(47,128,237,0.12)';
    ctx.fill();
    ctx.strokeStyle = '#2f80ed';
    ctx.lineWidth = 2 / this.camera.zoom;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  private marker(p: Vec, color: string, shape: 'ring' | 'small' | 'square'): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 / z;
    ctx.beginPath();
    if (shape === 'square') ctx.rect(p.x - 4 / z, p.y - 4 / z, 8 / z, 8 / z);
    else ctx.arc(p.x, p.y, (shape === 'ring' ? 8 : 5) / z, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * Тянут покупку на карту (ToolOverlay.buyDrop): у остановок линии — кружки с номерами, как в списке остановок;
   * куда отпустится — залит цветом линии и пульсирует. У курсора — значок машины, над остановкой — со стрелкой
   * отправления и номером, как над строкой списка.
   */
  private drawBuyDrop(d: NonNullable<ToolOverlay['buyDrop']>, cursor: Vec | null): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    for (const [a, b] of d.pairs) {
      this.drawPairLink(a, b, d.color);
      this.dropDot(b, null, d.color, false, 5);
    }
    const r = BUY_DOT_PX;
    for (const s of d.spots) if (!s.hot) this.dropDot(s.at, s.n, d.color, false, r);
    for (const s of d.spots) {
      if (!s.hot) continue;
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 3 / z;
      ctx.beginPath();
      ctx.arc(s.at.x, s.at.y, (r + 6 + pulse * 5) / z, 0, Math.PI * 2);
      ctx.stroke();
      this.dropDot(s.at, s.n, d.color, true, r + 2);
    }
    if (!cursor) return;
    // Значок у курсора — правее и ниже острия, чтобы не прятался под ним и под картинкой перетаскивания.
    const c = this.camera.toScreen(cursor);
    const at = (dx: number, dy: number) => this.camera.toWorld(c.x + dx, c.y + dy);
    // Мимо остановок — бледный значок без номера: отпустить здесь нельзя.
    const alpha = d.target === null ? 0.6 : 1;
    ctx.save();
    ctx.translate(cursor.x, cursor.y);
    ctx.scale(1 / z, 1 / z);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.strokeStyle = d.color;
    ctx.lineWidth = 2;
    rr(ctx, 16, 12, d.target === null ? 40 : 72, 28, 9);
    ctx.fill();
    ctx.stroke();
    if (d.target !== null) {
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.moveTo(51, 21);
      ctx.lineTo(59, 26);
      ctx.lineTo(51, 31);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = alpha;
    this.markGlyph({ pos: at(36, 26), dir: { x: 1, y: 0 }, r: 14 / z, cargo: null, kind: d.kind, color: d.color }, 14 / z);
    ctx.restore();
    if (d.target !== null) this.dropDot(at(73, 26), d.target, d.color, true, 10);
  }

  /** Кружок остановки экранного радиуса r пикселей с номером n: hot — залит цветом линии, иначе белый с обводкой. */
  private dropDot(at: Vec, n: number | null, color: string, hot: boolean, r: number): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.scale(1 / z, 1 / z);
    ctx.fillStyle = hot ? color : '#fff';
    ctx.strokeStyle = hot ? '#fff' : color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (n !== null) {
      ctx.fillStyle = hot ? '#fff' : color;
      ctx.font = `800 ${n > 9 ? Math.round(r * 0.95) : Math.round(r * 1.15)}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n), 0, 1);
    }
    ctx.restore();
  }

  private drawTooltip(at: Vec, text: string, ok: boolean, warn = false): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.scale(1 / z, 1 / z);
    ctx.font = '600 13px system-ui, -apple-system, sans-serif';
    // Длинная — в несколько строк не шире TOOLTIP_MAX_PX; у края экрана — сдвинута внутрь.
    const lines = wrapLines(text, TOOLTIP_MAX_PX, (s) => ctx.measureText(s).width);
    const w = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 14;
    const h = lines.length * 17 + 7;
    const s = this.camera.toScreen(at);
    const { x, y } = tooltipOffset(s.x, s.y, w, h, this.camera.width, this.camera.height);
    // Жёлтая (warn) — можно, но с оговоркой: тёмный текст на жёлтом.
    ctx.fillStyle = !ok ? 'rgba(170, 40, 35, 0.92)' : warn ? 'rgba(240, 190, 60, 0.96)' : 'rgba(25, 32, 45, 0.88)';
    rr(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.fillStyle = ok && warn ? '#2b2205' : '#fff';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    lines.forEach((line, i) => ctx.fillText(line, x + 7, y + 17 + i * 17));
    ctx.restore();
  }

  private drawFloaters(game: Game): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    for (const f of game.floaters) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - f.age / 2.5);
      ctx.translate(f.pos.x, f.pos.y - 20 / z - (f.age * 18) / z);
      ctx.scale(1 / z, 1 / z);
      ctx.font = '800 14px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(f.text, 0, 0);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, 0, 0);
      ctx.restore();
    }
  }
}

/** Гладкая линия через точки: квадратичные кривые между серединами отрезков. */
export function smoothPath(ctx: CanvasRenderingContext2D, pts: Vec[], k = 1): void {
  if (pts.length < 3) {
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k)));
    return;
  }
  ctx.moveTo(pts[0].x * k, pts[0].y * k);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x * k, pts[i].y * k, mx * k, my * k);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x * k, last.y * k);
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

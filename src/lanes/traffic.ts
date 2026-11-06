import { buildLaneProfile, gradeFactor, LaneProfile, PROFILE_STEP } from './speedProfile';
import { IDM, LIGHTS } from '../config';
import { lerp as lerpNum } from '../core/math';
import { rightNormal, scale, add, angleDiff, angleOf, closestOnSegment, dot, type Vec } from '../core/vec';
import { follow, hitchOf, jointOf, steerBase } from '../sim/body';
import type { Blinker, Vehicle, VehicleSpec } from '../sim/vehicle';
import { GLane, GLink, GMove, GNode, LaneGraph, LightPhase } from './graph';
import { bodyOnEnds, Corridor, layerOf } from './model';
import { findLaneRoute } from './routing';
import { onSolid, solidEnds } from './solid';
import { LANE_W } from '../world/roadTypes';

export interface LaneTrafficEvents {
  /**
   * Машина у цели остаётся на дороге (автобус на остановке — просто остановка в маршруте): true — стоит у конца
   * полосы, пока её не отправят дальше (continueTo). Спрашивается, пока стоит.
   */
  dwell?(v: Vehicle): boolean;
  /** Можно ли машине завершить поездку сейчас. */
  canArrive?(v: Vehicle): boolean;
  onArrive(v: Vehicle): void;
  onLost(v: Vehicle): void;
}

export interface LaneSpawn extends VehicleSpec {
  targetNode: number;
  /** Связи от первой до той, что приходит в targetNode. */
  route: number[];
}

/** Сколько машина смотрит вперёд через продолжения полос в поисках лидера. */
const LOOKAHEAD = 250;
/** Насколько вперёд по маршруту машина выбирает полосу: к съезду и повороту перестраивается заранее. */
const PLAN_AHEAD = 600;
/** Сколько дороги нужно на одно перестроение: на связи короче — перестраиваться тяжело. */
const CHANGE_ROOM = 120;
/**
 * Трудность остановиться у цели не у бордюра — за каждую полосу от крайней правой. Больше, чем перестроение
 * даже на коротком «кармашке» у остановки (там места на него мало — см. changePenalty).
 */
export const CURB_PULL = 4.5;
/** Насколько труднее перестроение на каждой следующей связи впереди (доля). */
export const LATE_CHANGE = 0.3;
/** Автобус держится крайней правой полосы: трудность за каждую полосу левее — на каждой связи пути. */
export const BUS_RIGHT = 1.2;
/** Из «кармашка» (крайней правой) автобус выезжает не дальше стольких метров до его конца. */
export const BUS_MERGE = 30;
/** Трудность ехать по полосе l связи: автобусу — левее крайней правой. */
export const keepRightCost = (lanes: number, index: number, keepRight: boolean) => (keepRight ? (lanes - 1 - index) * BUS_RIGHT : 0);

/**
 * Трудность n перестроений на отрезке длиной room: само число перестроений и штраф, если места
 * на них меньше, чем надо, — тогда лучше перестроиться раньше, на связи подлиннее.
 */
export const changePenalty = (n: number, room: number) => (n ? n + (Math.max(0, n * CHANGE_ROOM - room) / CHANGE_ROOM) * 3 : 0);

/**
 * План полос на связи маршрута: stay — трудность дальнейшего пути, если проехать связь по этой полосе
 * без перестроений; cost — то же, если до конца связи можно перестроиться (на всю её длину).
 */
interface LanePlan {
  link: GLink;
  stay: Map<number, number>;
  cost: Map<number, number>;
}
/** После стольких секунд ожидания на второстепенной машину пропускают, даже если главная не пустеет. */
const COURTESY = 40;
/** Бронь узла машиной, которой ехать до него дольше, — «мягкая»: её можно перехватить. */
const SOFT_GRANT = 3.5;
/**
 * Налево на общий зелёный: встречный ближе стольких секунд до узла — ждём (не меньше SOFT_GRANT: иначе поворачивающий
 * перехватит бронь встречного, и тот затормозит на свой зелёный). Прождав 10 с, а потом 25 с, — соглашаемся на окно
 * поменьше: при плотном встречном потоке иначе не повернуть вовсе.
 */
const lightYieldWindow = (waited: number) => (waited > 25 ? 2.2 : waited > 10 ? 2.8 : 3.5);
/** Не дождавшийся окна налево поворачивает на жёлтый (встречные уже стоят), если он не дальше стольких метров от стоп-линии. */
const LAST_CALL_REACH = 12;

/** Поворотник перед узлом включают не ближе стольких метров до него… */
const SIGNAL_AHEAD = 50;
/** …и не меньше чем за столько секунд (на быстрой дороге — раньше). */
const SIGNAL_AHEAD_TIME = 2.5;
/** Поворот в узле — когда курс меняется больше чем на 25°. */
const TURN_ANGLE = (25 * Math.PI) / 180;
/** Съезд на ответвление в стыке: на сколько метров вперёд смотреть, куда уходит полоса… */
const FORK_LOOK = 80;
/** …и насколько её курс там расходится с главной ветвью (8°), чтобы мигать. */
const FORK_BEND = (8 * Math.PI) / 180;
/** Свернувшая на ответвление мигает ещё столько метров после стыка. */
const FORK_AFTER = 30;
/** К перестроению по плану полос поворотник включают за столько секунд до него (само оно не ждёт). */
const SIGNAL_LEAD = 1;
/** Перестроившись, мигают, пока смещаются вбок, и не меньше стольких секунд от включения поворотника. */
const SIGNAL_MIN = 1;

/** Поворотник манёвра в узле по курсу въезда и выезда: разворот — левый, почти прямо — выключен (экран: y вниз). */
export function turnSide(dirIn: Vec, dirOut: Vec): Blinker {
  if (dot(dirIn, dirOut) < -0.95) return -1;
  const a = angleDiff(angleOf(dirIn), angleOf(dirOut));
  return Math.abs(a) > TURN_ANGLE ? (a > 0 ? 1 : -1) : 0;
}

function idmAccel(v: number, v0: number, gap: number, dv: number, aMax: number): number {
  const sStar = IDM.minGap + Math.max(0, v * IDM.headway + (v * dv) / (2 * Math.sqrt(aMax * IDM.brake)));
  const free = 1 - Math.pow(v / Math.max(0.1, v0), 4);
  const g = Math.max(0.1, gap);
  return aMax * (free - (sStar / g) * (sStar / g));
}

/** Детерминированный разброс 0…1 — чтобы машины не перестраивали маршрут одновременно. */
function jitter(x: number): number {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Сколько машин с оборванным правкой сети маршрутом прокладывают его заново за такт (rerouteCuts). Числом машин, а не
 * временем: партия с теми же действиями должна повторяться.
 */
export const REROUTE_BATCH = 24;
/** Подъезжающую к разрыву маршрута ближе стольких метров (и ещё 2 с пути) перестраивают сразу, вне очереди. */
export const REROUTE_NEAR = 30;

/** Шлагбаум посреди полотна (переезд): закрыт — машины ждут перед ним; занят — на нём машина. */
export interface Barrier {
  /** Где на оси полотна. */
  s: number;
  closed: boolean;
  busy: boolean;
}

/** Стоп-линия — на столько раньше шлагбаума (полпути и запас). */
const BARRIER_STOP = 12;

// ---------- Очереди полос и манёвров ----------
// Машина знает своё место в очереди (queueIdx): каждая вставка и удаление ниже переписывают его у всех, кто за ней.

/**
 * Место машины в очереди list (vehicles полосы или манёвра) — по её queueIdx, без поиска; индекс сверяется с очередью,
 * так что ошибиться не может: очередь меняли в обход этих функций (в тестах) — ищется, как прежде. Нет в ней — −1.
 */
export function queueIndex(list: Vehicle[], veh: Vehicle): number {
  const i = veh.queueIdx ?? -1;
  return i >= 0 && list[i] === veh ? i : list.indexOf(veh);
}

/** Места в очереди с from до конца — заново: за вставленной или убранной машиной все сдвинулись. */
function renumber(list: Vehicle[], from: number): void {
  for (let i = from; i < list.length; i++) list[i].queueIdx = i;
}

/** В конец очереди. */
function queuePush(list: Vehicle[], veh: Vehicle): void {
  veh.queueIdx = list.length;
  list.push(veh);
}

/** В очередь по s — от головной к хвосту; среди стоящих там же, где она, — последней. */
function insertSorted(list: Vehicle[], veh: Vehicle): void {
  let i = list.length;
  while (i > 0 && list[i - 1].s < veh.s) i--;
  list.splice(i, 0, veh);
  renumber(list, i);
}

/** Из очереди (нет в ней — ничего). */
function queueRemove(list: Vehicle[], veh: Vehicle): void {
  const i = queueIndex(list, veh);
  if (i < 0) return;
  list.splice(i, 1);
  renumber(list, i);
}

/** Головную — из очереди. */
function queueShift(list: Vehicle[]): void {
  list.shift();
  renumber(list, 0);
}

/** Очереди графа, где место машины (queueIdx) не совпадает с настоящим: «полоса id: машина id на i, а записано j». */
export function queueMismatches(graph: LaneGraph): string[] {
  const out: string[] = [];
  const check = (what: string, list: Vehicle[]) =>
    list.forEach((v, i) => {
      if (v.queueIdx !== i) out.push(`${what}: машина ${v.id} на ${i}, а записано ${v.queueIdx}`);
    });
  for (const lane of graph.lanes.values()) check(`полоса ${lane.id}`, lane.vehicles);
  for (const m of graph.moves.values()) check(`манёвр ${m.key}`, m.vehicles);
  return out;
}

/**
 * Движение по сети полос. Модель следования (IDM), перестроения внутри связи и проезд перекрёстков
 * по очереди с конфликтами и главной дорогой — как в прежней модели; продолжение полосы через стык
 * или границу связи проходится без остановки, лидер ищется и за ним.
 */
export class LaneTraffic {
  readonly vehicles = new Map<number, Vehicle>();
  private nextId = 1;
  time = 0;
  arrivals = 0;
  totalTripTime = 0;
  /** Шлагбаумы по полотнам. */
  barriers = new Map<number, Barrier[]>();
  /**
   * Стоп-линии перед закрытыми шлагбаумами — на такт (barrierAhead): по связям, по оси полотна. За такт движения
   * шлагбаумы не меняются — их закрывает и открывает ж/д после него (rail.step), а переезды заново ищутся при правке
   * сети, вне такта. null — закрытых нет.
   */
  private closedStops: Map<number, number[]> | null = null;
  /** План полос машины (см. lanePlan) — пока те же граф, маршрут и связь маршрута. */
  private plans = new WeakMap<Vehicle, { graph: LaneGraph; route: number[]; from: number; plan: LanePlan[] }>();
  /** Поворотник манёвра (см. turnSignal): у нового графа — новые манёвры. */
  private turns = new WeakMap<GMove, Blinker>();
  /** Рельеф для уклонов: отметка земли (null — плоский мир) и версия правок рельефа. */
  relief: { ground: () => ((p: Vec) => number) | null; version: () => number } | null = null;
  /** Профили скорости полос (изгибы и уклоны) — по версии рельефа. */
  private profiles = new WeakMap<GLane, { ver: number; p: LaneProfile }>();
  /**
   * Машины, чей маршрут правка сети оборвала (rebind): маршрут до разрыва, по нему и узнаём, что его ещё не сменили.
   * По порядку пересчёта — ближние к разрыву первыми (rerouteCuts).
   */
  private cuts = new Map<Vehicle, number[]>();
  /** Сколько оборванных маршрутов пересчитывать за такт (REROUTE_BATCH; в тестах — меньше). */
  rerouteBatch = REROUTE_BATCH;

  /** Профиль полосы: скорость по изгибам с торможением заранее и уклон по ходу. */
  profile(lane: GLane): LaneProfile {
    const ver = this.relief?.version() ?? 0;
    const hit = this.profiles.get(lane);
    if (hit && hit.ver === ver) return hit.p;
    const p = buildLaneProfile(this.graph, lane, this.relief?.ground() ?? null);
    this.profiles.set(lane, { ver, p });
    return p;
  }

  constructor(
    public graph: LaneGraph,
    private readonly events: LaneTrafficEvents,
  ) {}

  /**
   * Сеть перестроили. Машина, чья полоса (или манёвр в узле) осталась как была (см. LaneGraph.laneFromPrev), едет
   * дальше как ехала: та же полоса, место, очередь, бронь узла и маршрут — по соответствию связей, без поиска полосы
   * и пути. Маршрут — до первой поменявшейся связи или узла; если он там оборвался, машина встаёт в очередь
   * на новый маршрут (cuts — ближние к разрыву первыми, по REROUTE_BATCH за такт). Новые короткие пути она найдёт
   * сама (rerouteTimer). Остальные встают на полосу нового графа там же, где ехали (ближайшая попутная полоса
   * у их положения), и прокладывают маршрут сразу. Кому некуда — теряются.
   */
  rebind(graph: LaneGraph): void {
    // Светофоры не сбрасываются: та же фаза и тот же отсчёт, если фаз столько же.
    for (const [id, g] of graph.nodes) {
      const was = this.graph.nodes.get(id)?.lights;
      if (g.lights && was && was.phases.length === g.lights.phases.length) {
        g.lights.phase = was.phase;
        g.lights.timer = was.timer;
        g.lights.clearing = was.clearing;
      }
    }
    const old = this.graph;
    this.graph = graph;
    // Соответствие связей — только к графу, из которого этот собран; иначе все — заново.
    const keyed = graph.prevSerial === old.serial;
    const kept = new Set<Vehicle>();
    const cut: Vehicle[] = [];
    const placed: Vehicle[] = [];
    for (const veh of [...this.vehicles.values()]) {
      const c = keyed ? this.carryOver(old, veh) : null;
      if (c === null) placed.push(veh);
      else {
        kept.add(veh);
        if (c) cut.push(veh);
      }
    }
    if (keyed) {
      // Профили скорости прежних полос — те же.
      for (const [o, n] of graph.laneFromPrev) {
        const ol = old.lanes.get(o);
        const hit = ol && this.profiles.get(ol);
        if (hit) this.profiles.set(graph.lanes.get(n)!, hit);
      }
      this.keepQueues(old, kept);
    }
    // Очередь на новый маршрут: ближние к разрыву — первыми.
    const order = cut.map((veh) => ({ veh, d: this.routeLeft(veh) })).sort((a, b) => a.d - b.d || a.veh.id - b.veh.id);
    this.cuts = new Map(order.map(({ veh }) => [veh, veh.route]));
    for (const veh of placed) {
      // Посреди перекрёстка, который правка поменяла: тот же поворот есть и в новом — едет по нему дальше.
      if (keyed && veh.onMovement && this.sameTurn(old, veh)) continue;
      // Иначе полосы под машиной нет — ставим её в начало полосы, куда она выезжала.
      const exit = veh.onMovement ? this.exitSpot(old, veh.onMovement) : null;
      veh.onMovement = null;
      veh.granted = null;
      veh.planned = null;
      veh.waitingAt = null;
      veh.ready = false;
      const spot = this.laneAt(veh.pos, veh.dir) ?? exit;
      const route = spot && findLaneRoute(graph, [graph.links.get(spot.lane.link)!], veh.targetNode);
      if (!spot || !route) {
        this.vehicles.delete(veh.id);
        this.events.onLost(veh);
        continue;
      }
      veh.lane = spot.lane.id;
      veh.s = spot.u;
      veh.route = route;
      veh.routeIndex = 0;
      veh.lateral = 0;
      veh.laneSignal = 0;
      veh.laneSignalUntil = undefined;
      insertSorted(spot.lane.vehicles, veh);
      this.updatePose(veh);
      veh.blinker = this.blinkerOf(veh);
    }
  }

  /**
   * Машина остаётся где была (rebind): её полоса или манёвр — в новом графе по соответствию прежнего (laneFromPrev),
   * маршрут — его связи до первой поменявшейся (или перехода и узла, что поменялись), бронь и очередь узла — если узел
   * как был. Полосы нет — null (машину ставят заново); иначе — оборвался ли маршрут (не доходит до цели).
   */
  private carryOver(old: LaneGraph, veh: Vehicle): boolean | null {
    const g = this.graph;
    let lane: number | undefined;
    let move: string | null = null;
    if (veh.onMovement) {
      const m = this.sameMove(old, veh.onMovement);
      if (!m) return null;
      move = m.key;
      lane = m.inLane;
    } else lane = g.laneFromPrev.get(veh.lane);
    if (lane === undefined) return null;
    const from = veh.routeIndex;
    const route: number[] = [];
    let broken = false;
    for (let i = from; i < veh.route.length; i++) {
      const id = g.linkFromPrev.get(veh.route[i]);
      if (id === undefined || (i > from && !this.sameStep(old, veh.route[i - 1], veh.route[i]))) {
        broken = true;
        break;
      }
      route.push(id);
    }
    // Связь под машиной поменялась (или манёвр ведёт за разрыв) — ставим заново.
    if (!route.length || g.lanes.get(lane)!.link !== route[0] || (move && route.length < 2)) return null;
    // Прошлая связь (по ней поворотник у развилки) — если и она, и переход с неё прежние.
    const back = from > 0 ? g.linkFromPrev.get(veh.route[from - 1]) : undefined;
    const withBack = back !== undefined && this.sameStep(old, veh.route[from - 1], veh.route[from]);
    veh.route = withBack ? [back, ...route] : route;
    veh.routeIndex = withBack ? 1 : 0;
    veh.lane = lane;
    veh.onMovement = move;
    veh.granted = veh.granted ? (this.sameMove(old, veh.granted)?.key ?? null) : null;
    veh.planned = veh.planned ? (this.sameMove(old, veh.planned)?.key ?? null) : null;
    if (veh.waitingAt !== null && !g.sameNodes.has(veh.waitingAt)) {
      veh.waitingAt = null;
      veh.ready = false;
    }
    return broken || this.cuts.has(veh) || g.links.get(route[route.length - 1])!.toNode !== veh.targetNode;
  }

  /**
   * Машина посреди перекрёстка, который правка поменяла (rebind): тот же поворот в новом графе — с той же полосы того
   * же полотна на ту же полосу полотна выезда (связи у узла могли укоротиться или удлиниться). Есть — машина на нём,
   * в ближайшей к ней точке кривой, с новым маршрутом от выезда (сразу) и в брони узла; true. Нет — false.
   */
  private sameTurn(old: LaneGraph, veh: Vehicle): boolean {
    const g = this.graph;
    const m = old.moves.get(veh.onMovement!);
    if (!m || m.node === null) return false;
    const spot = (laneId: number, list: GLink[] | undefined) => {
      const lane = old.lanes.get(laneId)!;
      const link = old.links.get(lane.link)!;
      const now = list?.find((l) => l.corridor === link.corridor && l.flow === link.flow);
      return now && { link: now, lane: g.laneOf(now, lane.laneIdx) };
    };
    const from = spot(m.inLane, g.inLinks.get(m.node));
    const to = spot(m.outLane, g.outLinks.get(m.node));
    const nm = from?.lane && to?.lane ? g.moves.get(`${from.lane.id}>${to.lane.id}`) : undefined;
    const node = nm && g.nodes.get(m.node);
    const rest = nm && findLaneRoute(g, [to!.link], veh.targetNode);
    if (!nm || !node || !rest) return false;
    // Где на новой кривой машина: ближайшая к ней точка.
    let best = Infinity;
    let s = 0;
    for (let i = 1; i < nm.points.length; i++) {
      const hit = closestOnSegment(veh.pos, nm.points[i - 1], nm.points[i]);
      if (hit.d < best) {
        best = hit.d;
        s = nm.cum[i - 1] + (nm.cum[i] - nm.cum[i - 1]) * hit.t;
      }
    }
    veh.lane = from!.lane!.id;
    veh.onMovement = nm.key;
    veh.s = Math.min(s, nm.length);
    veh.route = [from!.link.id, ...rest];
    veh.routeIndex = 0;
    veh.granted = null;
    veh.planned = null;
    veh.waitingAt = null;
    veh.ready = false;
    veh.lateral = 0;
    insertSorted(nm.vehicles, veh);
    node.reserved.push(veh);
    this.updatePose(veh);
    veh.blinker = this.blinkerOf(veh);
    return true;
  }

  /** Манёвр key прежнего графа — в новом: полосы как были, узел (если это манёвр в узле) как был. Нет — undefined. */
  private sameMove(old: LaneGraph, key: string): GMove | undefined {
    const m = old.moves.get(key);
    const g = this.graph;
    const i = m && g.laneFromPrev.get(m.inLane);
    const o = m && g.laneFromPrev.get(m.outLane);
    if (!m || i === undefined || o === undefined || (m.node !== null && !g.sameNodes.has(m.node))) return undefined;
    return g.moves.get(`${i}>${o}`);
  }

  /** Переход маршрута со связи a на b (прежние id) — как был: все его манёвры есть и в новом графе, узел как был. */
  private sameStep(old: LaneGraph, a: number, b: number): boolean {
    const was = old.transitions.get(`${a}>${b}`) ?? [];
    const now = this.graph.transitions.get(`${this.graph.linkFromPrev.get(a)}>${this.graph.linkFromPrev.get(b)}`) ?? [];
    return was.length > 0 && was.length === now.length && was.every((m) => !!this.sameMove(old, m.key));
  }

  /**
   * Очереди полос и манёвров и брони узлов для оставшихся на месте (kept) — в прежнем порядке; узел, что поменялся,
   * начинает с пустыми (брони там сняты в carryOver).
   */
  private keepQueues(old: LaneGraph, kept: Set<Vehicle>): void {
    const g = this.graph;
    const queued = new Set<Vehicle>();
    for (const lane of old.lanes.values()) {
      for (const veh of lane.vehicles) {
        if (!kept.has(veh) || veh.onMovement || queued.has(veh)) continue;
        queuePush(g.lanes.get(veh.lane)!.vehicles, veh);
        queued.add(veh);
      }
    }
    for (const m of old.moves.values()) {
      for (const veh of m.vehicles) {
        if (!kept.has(veh) || !veh.onMovement || queued.has(veh)) continue;
        queuePush(g.moves.get(veh.onMovement)!.vehicles, veh);
        queued.add(veh);
      }
    }
    // Не нашлась ни в одной очереди (не должно быть) — по месту.
    for (const veh of kept) if (!queued.has(veh)) insertSorted(veh.onMovement ? g.moves.get(veh.onMovement)!.vehicles : g.lanes.get(veh.lane)!.vehicles, veh);
    const nodeOf = (key: string | null) => (key ? (g.moves.get(key)?.node ?? null) : null);
    for (const [id, was] of old.nodes) {
      const node = g.nodes.get(id);
      if (!node || !g.sameNodes.has(id)) continue;
      node.reserved = was.reserved.filter((v) => kept.has(v) && nodeOf(v.onMovement ?? v.granted) === id);
      node.waiting = was.waiting.filter((v) => kept.has(v) && v.waitingAt === id);
    }
  }

  /** Сколько машине ехать до конца её маршрута (у оборванного — до разрыва). */
  private routeLeft(veh: Vehicle): number {
    const g = this.graph;
    let d: number;
    if (veh.onMovement) {
      const m = g.moves.get(veh.onMovement);
      d = m ? m.length - veh.s : 0;
    } else {
      const lane = this.currentLane(veh);
      d = lane ? lane.length - veh.s : 0;
    }
    for (let i = veh.routeIndex + 1; i < veh.route.length; i++) d += g.links.get(veh.route[i])?.length ?? 0;
    return d;
  }

  /**
   * Машины с оборванным правкой маршрутом (cuts): по REROUTE_BATCH за такт — по порядку очереди (ближние к разрыву
   * первыми), а та, что подъезжает к разрыву (ближе REROUTE_NEAR и ещё 2 с пути) или уже на последней связи, — сразу.
   * Маршрут сменился сам (перестройка по таймеру, отправили дальше) — из очереди прочь.
   */
  private rerouteCuts(): void {
    let batch = this.rerouteBatch;
    for (const [veh, route] of this.cuts) {
      if (!this.vehicles.has(veh.id) || veh.route !== route) {
        this.cuts.delete(veh);
        continue;
      }
      const near = veh.routeIndex >= veh.route.length - 1 || this.routeLeft(veh) < REROUTE_NEAR + veh.v * 2;
      if (!near && batch <= 0) continue;
      if (!near) batch--;
      this.cuts.delete(veh);
      this.rerouteCut(veh);
    }
  }

  /** Новый маршрут машине с оборванным: с её связи (посреди манёвра — со связи выезда). Не доехать — теряется. */
  private rerouteCut(veh: Vehicle): void {
    const g = this.graph;
    if (veh.onMovement) {
      const m = g.moves.get(veh.onMovement);
      const out = m && g.links.get(m.outLink);
      const rest = out && findLaneRoute(g, [out], veh.targetNode);
      if (!m || !rest) return this.lose(veh);
      veh.route = [m.inLink, ...rest];
      veh.routeIndex = 0;
      return;
    }
    const lane = this.currentLane(veh);
    const link = lane && g.links.get(lane.link);
    const route = link && findLaneRoute(g, [link], veh.targetNode);
    if (!route) return this.lose(veh);
    this.setRoute(veh, route);
  }

  /** Маршрут машины оборван правкой сети и ждёт пересчёта (rerouteCuts): к его концу не тормозит, полосу не меняет. */
  routeCut(veh: Vehicle): boolean {
    return this.cuts.has(veh);
  }

  /** Попутная полоса у точки: ближайшая по смещению среди связей, идущих примерно по dir. */
  /**
   * Начало полосы выезда манёвра moveKey старого графа — в новом графе (this.graph): то же полотно, тот же
   * ход и та же полоса полотна у того же конца. Полотна при перестройке сохраняют номера. Нет — null.
   */
  private exitSpot(old: LaneGraph, moveKey: string): { lane: GLane; u: number } | null {
    const m = old.moves.get(moveKey);
    const outLane = m && old.lanes.get(m.outLane);
    const outLink = outLane && old.links.get(outLane.link);
    if (!outLane || !outLink) return null;
    // Выезд — с того конца связи, откуда по ней едут.
    const start = outLink.flow > 0 ? outLink.s0 : outLink.s1;
    for (const link of this.graph.corridorLinks(outLink.corridor)) {
      if (link.flow !== outLink.flow || Math.abs((link.flow > 0 ? link.s0 : link.s1) - start) > 1) continue;
      const lane = link.lanes.find((l) => l.laneIdx === outLane.laneIdx) ?? link.lanes.find((l) => Math.abs(l.offset - outLane.offset) < 1);
      if (lane) return { lane, u: 0 };
    }
    return null;
  }

  private laneAt(p: Vec, dir: Vec): { lane: GLane; u: number } | null {
    let best: { lane: GLane; u: number } | null = null;
    let bestD = 6;
    for (const c of this.graph.net.corridorsNear(p, 40)) {
      const hit = c.lut.closest(p);
      if (hit.d > 40) continue;
      const t = c.lut.tangentAt(hit.s);
      const lat = (p.x - hit.point.x) * -t.y + (p.y - hit.point.y) * t.x;
      for (const link of this.graph.corridorLinks(c.id)) {
        if (hit.s < link.s0 - 0.5 || hit.s > link.s1 + 0.5 || (t.x * dir.x + t.y * dir.y) * link.flow < 0.3) continue;
        for (const lane of link.lanes) {
          const d = Math.abs(lane.offset - lat);
          if (d < bestD) {
            bestD = d;
            const u = link.flow > 0 ? hit.s - link.s0 : link.s1 - hit.s;
            best = { lane, u: Math.max(0, Math.min(lane.length, u)) };
          }
        }
      }
    }
    return best;
  }

  currentLane(v: Vehicle): GLane | undefined {
    return this.graph.lanes.get(v.lane);
  }

  private hasTransition(lane: GLane, nextLink: number): boolean {
    for (const m of this.graph.movesFrom.get(lane.id) ?? []) if (m.outLink === nextLink) return true;
    return false;
  }

  private spaceAtStart(lane: GLane, need: number): boolean {
    const last = lane.vehicles[lane.vehicles.length - 1];
    if (last && last.s - last.length < need) return false;
    for (const m of this.graph.movesInto.get(lane.id) ?? []) {
      for (const veh of m.vehicles) if (m.length - veh.s < need) return false;
    }
    return true;
  }

  spawn(opts: LaneSpawn): Vehicle | null {
    const link = this.graph.links.get(opts.route[0]);
    if (!link) return null;
    const next = opts.route[1];
    const rightFirst = [...link.lanes].reverse();
    const good = next === undefined ? rightFirst : rightFirst.filter((l) => this.hasTransition(l, next));
    const lane = (good.length ? good : rightFirst).find((l) => this.spaceAtStart(l, opts.length + IDM.minGap + 1));
    if (!lane) return null;
    const { targetNode, route, ...spec } = opts;
    const veh = this.create(spec, targetNode, route, lane, 0, 3);
    queuePush(lane.vehicles, veh);
    return veh;
  }

  /**
   * Ставит машину на попутную полосу у точки pos с курсом dir (как при перестройке сети) и прокладывает
   * маршрут к targetNode — так машины из сохранения едут дальше. Некуда поставить или не доехать — null.
   */
  place(opts: VehicleSpec & { targetNode: number }, pos: Vec, dir: Vec, v = 0): Vehicle | null {
    const spot = this.laneAt(pos, dir);
    const route = spot && findLaneRoute(this.graph, [this.graph.links.get(spot.lane.link)!], opts.targetNode);
    if (!spot || !route) return null;
    const { targetNode, ...spec } = opts;
    const veh = this.create(spec, targetNode, route, spot.lane, spot.u, v);
    insertSorted(spot.lane.vehicles, veh);
    return veh;
  }

  /** Где машина для сохранения: на манёвре в узле — уже в начале полосы выезда из него (туда её и поставят). */
  spotOf(veh: Vehicle): { pos: Vec; dir: Vec } {
    const m = veh.onMovement ? this.graph.moves.get(veh.onMovement) : undefined;
    const lane = m && this.graph.lanes.get(m.outLane);
    const pose = lane ? this.graph.lanePose(lane, 0) : veh;
    return { pos: { ...pose.pos }, dir: { ...pose.dir } };
  }

  /**
   * Машина, что стоит у цели (dwell), едет дальше — к targetNode, оттуда же, где стоит: маршрут от её связи.
   * Не доехать — false (стоит дальше).
   */
  continueTo(veh: Vehicle, targetNode: number): boolean {
    const lane = this.currentLane(veh);
    const link = lane && this.graph.links.get(lane.link);
    if (!link || veh.onMovement) return false;
    const route = findLaneRoute(this.graph, [link], targetNode);
    if (!route) return false;
    veh.targetNode = targetNode;
    this.setRoute(veh, route);
    veh.tripTime = 0;
    veh.stoppedTime = 0;
    return true;
  }

  /** Остановиться, проехав ещё d метров по маршруту, и стоять, пока не отпустят (release). */
  holdAfter(veh: Vehicle, d: number): void {
    veh.holdDist = Math.max(0, d);
  }

  /** Доехала до места остановки (holdAfter) и стоит. */
  held(veh: Vehicle): boolean {
    return veh.holdDist !== undefined && veh.holdDist < 0.5 && veh.v < 0.3;
  }

  release(veh: Vehicle): void {
    delete veh.holdDist;
  }

  /**
   * Другой кузов той же машине прямо на ходу (замена модели): нос, полоса, скорость и маршрут — прежние, корма —
   * по новой длине. Длиннее прежней — только вне узла и если сзади до соседа хватает места, как при выезде
   * на полосу (spaceAtStart); иначе false — кузов не меняется, пусть попробуют позже.
   */
  reshape(veh: Vehicle, body: Omit<VehicleSpec, 'color' | 'load'>): boolean {
    if (body.length > veh.length) {
      const lane = this.currentLane(veh);
      const i = lane && !veh.onMovement ? queueIndex(lane.vehicles, veh) : -1;
      if (!lane || i < 0) return false;
      const rear = veh.s - body.length - IDM.minGap;
      const behind = lane.vehicles[i + 1];
      if (behind && behind.s > rear) return false;
      if (rear < 0) for (const m of this.graph.movesInto.get(lane.id) ?? []) for (const o of m.vehicles) if (m.length - o.s < -rear) return false;
    }
    Object.assign(veh, body);
    // Оси кузова — заново под новую длину (и вторую секцию, если она теперь есть).
    delete veh.rear;
    delete veh.trail;
    this.updatePose(veh);
    return true;
  }

  /** Машина стоит так, что её можно объехать: слева от её полосы есть попутная (она в «кармашке» или крайней правой). */
  standsAside(veh: Vehicle): boolean {
    const lane = this.currentLane(veh);
    return !!lane && lane.index > 0;
  }

  /** Новая машина на полосе lane в s (в очередь полосы её ставит вызывающий). */
  private create(spec: VehicleSpec, targetNode: number, route: number[], lane: GLane, s: number, v: number): Vehicle {
    const pose = this.graph.lanePose(lane, Math.min(s, lane.length));
    const veh: Vehicle = {
      ...spec,
      id: this.nextId++,
      targetNode,
      route,
      routeIndex: 0,
      lane: lane.id,
      // Место в очереди проставит вставка в неё (queuePush, insertSorted).
      queueIdx: -1,
      onMovement: null,
      granted: null,
      planned: null,
      waitingAt: null,
      requestTime: 0,
      ready: false,
      s,
      v,
      pos: pose.pos,
      dir: pose.dir,
      level: 0,
      centerS: 0,
      lateral: 0,
      tripTime: 0,
      stoppedTime: 0,
      stuckTimer: 0,
      rerouteTimer: 3 + jitter(this.nextId) * 3,
      lcCooldown: 0.5,
      blinker: 0,
    };
    this.vehicles.set(veh.id, veh);
    this.updatePose(veh);
    return veh;
  }

  remove(veh: Vehicle): void {
    if (!this.vehicles.has(veh.id)) return;
    this.vehicles.delete(veh.id);
    this.cuts.delete(veh);
    const lane = this.currentLane(veh);
    if (lane) queueRemove(lane.vehicles, veh);
    if (veh.onMovement) {
      const m = this.graph.moves.get(veh.onMovement);
      if (m) queueRemove(m.vehicles, veh);
    }
    this.releaseNode(veh);
  }

  private releaseNode(veh: Vehicle): void {
    for (const n of this.graph.nodes.values()) {
      if (n.reserved.includes(veh)) n.reserved = n.reserved.filter((x) => x !== veh);
      if (n.waiting.includes(veh)) n.waiting = n.waiting.filter((x) => x !== veh);
    }
    veh.waitingAt = null;
  }

  private revokeGrant(veh: Vehicle): void {
    if (!veh.granted) return;
    const m = this.graph.moves.get(veh.granted);
    const node = m?.node !== null && m ? this.graph.nodes.get(m.node) : undefined;
    if (node) node.reserved = node.reserved.filter((x) => x !== veh);
    veh.granted = null;
  }

  step(dt: number): void {
    this.time += dt;
    this.updateLights(dt);
    // Стоп-линии закрытых переездов — заново на каждый такт (barrierAhead); все открыты — их и не ищут.
    this.closedStops = this.anyBarrierClosed() ? new Map() : null;
    if (this.cuts.size) this.rerouteCuts();
    const list = [...this.vehicles.values()];
    for (const veh of list) if (!veh.onMovement) this.laneChange(veh, dt);
    const accel = new Array<number>(list.length);
    for (let i = 0; i < list.length; i++) accel[i] = this.computeAccel(list[i], dt);
    for (let i = 0; i < list.length; i++) if (this.vehicles.has(list[i].id)) this.integrate(list[i], accel[i], dt);
    for (const veh of list) {
      if (!this.vehicles.has(veh.id)) continue;
      veh.rerouteTimer -= dt;
      if (veh.rerouteTimer <= 0) {
        veh.rerouteTimer = 4 + jitter(veh.id + this.time) * 2;
        this.dynamicReroute(veh);
      }
      veh.blinker = this.blinkerOf(veh);
    }
    this.markBarriers();
  }

  // ---------- Поворотники ----------

  /**
   * Поворотник машины: перестраивается (собирается или уже смещается вбок) — в ту сторону; иначе —
   * поворот или разворот в узле впереди по маршруту (ближе SIGNAL_AHEAD) и пока его проезжает,
   * съезд на ответвление в стыке.
   */
  blinkerOf(veh: Vehicle): Blinker {
    // Останавливается у остановки или стоит на ней (посадка) — не мигает.
    if (veh.holdDist !== undefined) return 0;
    if (veh.onMovement) {
      const m = this.graph.moves.get(veh.onMovement);
      return m ? this.turnSignal(m) : 0;
    }
    if (veh.lateral !== 0) return veh.lateral < 0 ? 1 : -1;
    // Собирается перестроиться (ждёт окна или вот-вот начнёт) — или только что перестроилась.
    if (veh.laneSignal && (veh.laneSignalUntil === undefined ? !veh.granted : this.time < veh.laneSignalUntil)) return veh.laneSignal;
    const lane = this.currentLane(veh);
    if (!lane) return 0;
    // Только что ушла на ответвление — мигает, пока не отъедет от стыка.
    const prev = veh.route[veh.routeIndex - 1];
    if (prev !== undefined && veh.s < FORK_AFTER) {
      for (const m of this.graph.movesInto.get(lane.id) ?? []) if (m.cont && m.inLink === prev && this.turnSignal(m)) return this.turnSignal(m);
    }
    const reach = Math.max(SIGNAL_AHEAD, veh.v * SIGNAL_AHEAD_TIME);
    let ahead = lane.length - veh.s;
    let cur = lane;
    for (let ri = veh.routeIndex; ri < veh.route.length - 1 && ahead <= reach && ri < veh.routeIndex + 8; ri++) {
      const m = this.signalMove(veh, cur, ri);
      if (!m) return 0;
      const s = this.turnSignal(m);
      if (s || !m.cont) return s;
      const out = this.graph.lanes.get(m.outLane);
      if (!out) return 0;
      cur = out;
      ahead += out.length;
    }
    return 0;
  }

  /** Манёвр с полосы lane (на связи маршрута ri) на следующую связь: намеченный, любой с этой полосы или с этой связи. */
  private signalMove(veh: Vehicle, lane: GLane, ri: number): GMove | undefined {
    const next = veh.route[ri + 1];
    if (ri === veh.routeIndex && lane.id === veh.lane) {
      const key = veh.granted ?? veh.planned;
      const m = key ? this.graph.moves.get(key) : undefined;
      if (m && m.outLink === next) return m;
    }
    for (const m of this.graph.movesFrom.get(lane.id) ?? []) if (m.outLink === next) return m;
    // Не с той полосы (ещё перестроится) — поворот тот же, куда бы ни вела полоса связи.
    return this.graph.transitions.get(`${veh.route[ri]}>${next}`)?.[0];
  }

  /** Поворотник манёвра (считается раз на граф): в узле — по курсу въезда и выезда, в стыке — съезд на ответвление. */
  private turnSignal(m: GMove): Blinker {
    let s = this.turns.get(m);
    if (s === undefined) {
      s = m.cont ? this.forkSignal(m) : turnSide(m.dirIn, m.dirOut);
      this.turns.set(m, s);
    }
    return s;
  }

  /**
   * Продолжение полосы через стык, где связь расходится на несколько ветвей (съезд, развилка). Главная ветвь —
   * куда уходит больше всего полос: по ней едут не мигая. Съезжающий мигает в ту сторону, куда его полоса за
   * FORK_LOOK м уходит от главной (нет главной — от самой прямой из других ветвей), если заметно (FORK_BEND).
   * Не развилка — выключен.
   */
  private forkSignal(m: GMove): Blinker {
    const next = this.graph.linkNext.get(m.inLink);
    if (!next || next.size < 2) return 0;
    const branches = [...next].map((id) => {
      const moves = this.graph.transitions.get(`${m.inLink}>${id}`) ?? [];
      const lane = moves[0] && this.graph.lanes.get(moves[0].outLane);
      const dir = lane ? this.graph.lanePose(lane, Math.min(FORK_LOOK, lane.length)).dir : m.dirIn;
      return { id, lanes: moves.length, bend: angleDiff(angleOf(m.dirIn), angleOf(dir)) };
    });
    const mine = branches.find((b) => b.id === m.outLink);
    const most = Math.max(...branches.map((b) => b.lanes));
    const mains = branches.filter((b) => b.lanes === most);
    if (!mine || (mains.length === 1 && mains[0] === mine)) return 0;
    const others = mains.length === 1 ? mains : branches.filter((b) => b !== mine);
    const ref = others.reduce((a, b) => (Math.abs(b.bend) < Math.abs(a.bend) ? b : a));
    const d = mine.bend - ref.bend;
    return Math.abs(d) < FORK_BEND ? 0 : d > 0 ? 1 : -1;
  }

  /** Какие шлагбаумы заняты: машина между стоп-линией и дальним краем переезда. */
  private markBarriers(): void {
    if (!this.barriers.size) return;
    for (const list of this.barriers.values()) for (const b of list) b.busy = false;
    for (const veh of this.vehicles.values()) {
      if (veh.onMovement) continue;
      const lane = this.currentLane(veh);
      const link = lane && this.graph.links.get(lane.link);
      const list = link && this.barriers.get(link.corridor);
      if (!list) continue;
      for (const b of list) {
        const d = link.flow * (veh.centerS - b.s);
        if (d > -BARRIER_STOP && d < BARRIER_STOP + veh.length) b.busy = true;
      }
    }
  }

  private anyBarrierClosed(): boolean {
    for (const list of this.barriers.values()) for (const b of list) if (b.closed) return true;
    return false;
  }

  /** До ближайшего закрытого шлагбаума впереди на связи: от оси from (нет — от начала связи); нет — Infinity. */
  private barrierAhead(linkId: number, from: number | null): number {
    if (!this.closedStops) return Infinity;
    let stops = this.closedStops.get(linkId);
    if (!stops) {
      stops = [];
      const link = this.graph.links.get(linkId);
      for (const b of (link && this.barriers.get(link.corridor)) ?? []) {
        if (!b.closed) continue;
        const stop = b.s - link!.flow * BARRIER_STOP;
        if (stop >= link!.s0 - 0.01 && stop <= link!.s1 + 0.01) stops.push(stop);
      }
      this.closedStops.set(linkId, stops);
    }
    if (!stops.length) return Infinity;
    const link = this.graph.links.get(linkId)!;
    const start = from ?? (link.flow > 0 ? link.s0 : link.s1);
    let best = Infinity;
    for (const stop of stops) {
      // Проехавшая стоп-линию машина освобождает переезд, а не встаёт на рельсах.
      const d = link.flow * (stop - start);
      if (d > -0.5) best = Math.min(best, Math.max(0, d));
    }
    return best;
  }

  // ---------- Перестроения ----------

  /**
   * План полос по маршруту от текущей связи машины: сама связь и следующие — пока они начинаются
   * ближе PLAN_AHEAD от её конца. Считается с конца: трудность — сумма перестроений со штрафом за тесноту.
   */
  private lanePlan(veh: Vehicle): LanePlan[] {
    const hit = this.plans.get(veh);
    if (hit && hit.graph === this.graph && hit.route === veh.route && hit.from === veh.routeIndex) return hit.plan;
    const route = veh.route;
    const from = veh.routeIndex;
    const links: GLink[] = [];
    for (let i = from, dist = 0; i < route.length && dist < PLAN_AHEAD; i++) {
      const link = this.graph.links.get(route[i]);
      if (!link) break;
      links.push(link);
      if (i > from) dist += link.length;
    }
    const plan: LanePlan[] = new Array(links.length);
    for (let k = links.length - 1; k >= 0; k--) {
      const link = links[k];
      const next = route[from + k + 1];
      const stay = new Map<number, number>();
      for (const l of link.lanes) {
        let v = Infinity;
        // К цели (остановка, пост, дом) — к бордюру: в крайнюю правую полосу, в «кармашек» у остановки, если он есть.
        if (next === undefined) v = (link.lanes.length - 1 - l.index) * CURB_PULL;
        else if (k === links.length - 1) v = this.hasTransition(l, next) ? 0 : Infinity;
        else for (const m of this.graph.movesFrom.get(l.id) ?? []) if (m.outLink === next) v = Math.min(v, plan[k + 1].cost.get(m.outLane) ?? Infinity);
        // Автобус держится правее (как и линия маршрута на карте).
        v += keepRightCost(link.lanes.length, l.index, veh.kind === 'bus');
        stay.set(l.id, v);
      }
      const cost = new Map<number, number>();
      // Чем дальше связь, тем чуть труднее перестроиться на ней: «заранее» лучше, чем «в последний момент».
      // Места для перестроений — без сплошной у её концов (там нельзя).
      const [head, tail] = solidEnds(link.lanes, link.length);
      const room = Math.max(1, link.length - head - tail);
      for (const l of link.lanes) cost.set(l.id, this.bestLane(link, l, room, stay, 1 + LATE_CHANGE * k).cost);
      plan[k] = { link, stay, cost };
    }
    this.plans.set(veh, { graph: this.graph, route, from, plan });
    return plan;
  }

  /** Куда с полосы l перестроиться на связи (места — room), чтобы дальше было легче всего; сама l — при равенстве. */
  /** late — во сколько раз труднее то же перестроение на связях впереди: при равенстве перестраиваются раньше. */
  private bestLane(link: GLink, l: GLane, room: number, stay: Map<number, number>, late = 1): { lane: GLane; cost: number } {
    let best = { lane: l, cost: stay.get(l.id) ?? Infinity };
    for (const o of link.lanes) {
      const c = changePenalty(Math.abs(o.index - l.index), room) * late + (stay.get(o.id) ?? Infinity);
      if (c < best.cost - 1e-6) best = { lane: o, cost: c };
    }
    return best;
  }

  private laneChange(veh: Vehicle, dt: number): void {
    veh.lcCooldown -= dt;
    // Маршрут оборван правкой и ждёт пересчёта (такт-другой) — полосу по нему не выбирают.
    if (veh.lcCooldown > 0 || (this.cuts.size && this.cuts.has(veh))) return;
    // Поворотник перестроения решается заново при каждой проверке: горит, пока машина собирается перестроиться.
    const signal = veh.laneSignal ?? 0;
    veh.laneSignal = 0;
    veh.laneSignalUntil = undefined;
    // Останавливается или стоит у остановки (holdDist) — не перестраивается: встаёт ровно в своей полосе.
    if (veh.granted || veh.holdDist !== undefined) return;
    const lane = this.currentLane(veh);
    if (!lane) return;
    const link = this.graph.links.get(lane.link)!;
    if (link.lanes.length < 2 || link.id !== veh.route[veh.routeIndex]) return;
    const plan = this.lanePlan(veh);
    const { stay } = plan[0];
    // До конца связи — без сплошной у её конца: там уже не перестроиться.
    const remaining = Math.max(1, lane.length - veh.s - solidEnds(link.lanes, link.length)[1]);
    // Трудность пути с полосы, если перестраиваться отсюда до конца связи.
    const costFrom = (l: GLane) => this.bestLane(link, l, remaining, stay).cost;
    let target: GLane | undefined;
    let urgency = 0;
    let strategic = false;
    const goal = this.bestLane(link, lane, remaining, stay).lane;
    const end = goal === lane ? null : this.laneEnd(veh, lane, plan);
    veh.mergeWait = 0;
    // Автобус держится «кармашка» (крайней правой полосы) до её конца: выезжает из неё в последние метры, а не сразу.
    const holdRight = veh.kind === 'bus' && goal.index < lane.index && lane.index === link.lanes.length - 1 && !!end && end.changes <= 1;
    if (holdRight && end.dist > Math.max(BUS_MERGE, veh.v * 2.5)) return;
    if (end && end.dist < PLAN_AHEAD) {
      // Дальше по маршруту с другой полосы проще (съезд, поворот, полоса кончается) — перестраиваемся заранее;
      // чем ближе место, где своя полоса уже не ведёт, и чем больше там перестроений, тем настойчивее.
      target = link.lanes[lane.index + Math.sign(goal.index - lane.index)];
      urgency = Math.max(0, Math.min(1, 1 - end.dist / (end.changes * CHANGE_ROOM + 20)));
      strategic = true;
    } else if (goal !== lane && (veh.routeIndex === veh.route.length - 1 || veh.kind === 'bus')) {
      // Последняя связь до цели — к бордюру (в «кармашек» у остановки, сразу в его начале); автобус и в пути
      // держится правее. Без спешки: не пустят — поедет и в своей.
      target = link.lanes[lane.index + Math.sign(goal.index - lane.index)];
    } else if (remaining > 50) {
      const idx = queueIndex(lane.vehicles, veh);
      const leader = idx > 0 ? lane.vehicles[idx - 1] : undefined;
      const gapAhead = leader ? leader.s - leader.length - veh.s : Infinity;
      if (leader && gapAhead < 30 && leader.v < Math.min(lane.speed, veh.maxSpeed) * 0.7) {
        const mine = costFrom(lane);
        for (const d of [-1, 1]) {
          const adj = link.lanes[lane.index + d];
          // Обгон — только в полосу, с которой дальше не труднее.
          if (!adj || costFrom(adj) > mine + 1e-6) continue;
          if (this.freeAhead(adj, veh.s) > gapAhead + 20) {
            target = adj;
            break;
          }
        }
      }
    }
    // Перестроение по плану полос начнётся через SIGNAL_LEAD с — поворотник уже сейчас (само оно — как обычно).
    const soon = !target && end && end.dist < PLAN_AHEAD + veh.v * SIGNAL_LEAD ? link.lanes[lane.index + Math.sign(goal.index - lane.index)] : undefined;
    const toward = target ?? soon;
    if (!toward) return;
    // Через сплошную не перестраиваются.
    const leftOne = toward.index < lane.index ? toward : lane;
    if (leftOne.solidRight) return;
    // И через сплошную, что дорога рисует сама (у развилки, после вливания, перед перекрёстком), — пока машина рядом
    // с ней: вбок она сдвигается не сразу (как в integrate), линию пересечёт на полпути. Встала в конце своей полосы,
    // которая дальше не ведёт, — пусть уж перестроится, иначе так и стоять.
    const ahead = (veh.v * LANE_W) / (6 + veh.v * 0.2) / 2;
    const stuck = strategic && !!end && end.dist < 10 && veh.v < 2;
    if (!stuck && onSolid(leftOne.solidZones, veh.s, veh.length, ahead)) return;
    const side: Blinker = toward.index > lane.index ? 1 : -1;
    if (signal !== side) veh.laneSignalSince = this.time;
    veh.laneSignal = side;
    if (!target) return;
    if (this.safeToEnter(target, veh, urgency)) {
      this.moveToLane(veh, lane, target);
      // Поворотник горит, пока машина смещается вбок, и не меньше SIGNAL_MIN с от включения.
      veh.laneSignalUntil = (veh.laneSignalSince ?? this.time) + SIGNAL_MIN;
      veh.lcCooldown = strategic ? 0.8 : 3;
    } else {
      // Не пускают — чуть отстаём от соседнего потока, чтобы подошло окно.
      if (strategic) veh.mergeWait = Math.max(0.5, urgency);
      veh.lcCooldown = urgency > 0 ? 0.2 : 0.5;
    }
  }

  /**
   * Где своя полоса (и её продолжения по маршруту) перестаёт вести дальше: сколько до этого места
   * и сколько там перестроений до полосы, что ведёт. Ведёт до конца плана — dist = Infinity.
   */
  private laneEnd(veh: Vehicle, lane: GLane, plan: LanePlan[]): { dist: number; changes: number } {
    let dist = lane.length - veh.s;
    let cur = lane;
    for (let k = 0; k < plan.length; k++) {
      const p = plan[k];
      if ((p.stay.get(cur.id) ?? Infinity) === Infinity) {
        let changes = Infinity;
        for (const o of p.link.lanes) if ((p.stay.get(o.id) ?? Infinity) < Infinity) changes = Math.min(changes, Math.abs(o.index - cur.index));
        return { dist, changes: Number.isFinite(changes) ? changes : 1 };
      }
      if (k + 1 >= plan.length) break;
      const next = veh.route[veh.routeIndex + k + 1];
      let best: GLane | undefined;
      let bestCost = Infinity;
      for (const m of this.graph.movesFrom.get(cur.id) ?? []) {
        if (m.outLink !== next) continue;
        const c = plan[k + 1].cost.get(m.outLane) ?? Infinity;
        if (c < bestCost) {
          bestCost = c;
          best = this.graph.lanes.get(m.outLane);
        }
      }
      if (!best) return { dist, changes: 1 };
      cur = best;
      dist += best.length;
    }
    return { dist: Infinity, changes: 0 };
  }

  private freeAhead(lane: GLane, s: number): number {
    let best = Infinity;
    for (const o of lane.vehicles) if (o.s >= s) best = o.s - o.length - s;
    return Math.min(best, lane.length - s + 30);
  }

  private safeToEnter(target: GLane, veh: Vehicle, urgency: number): boolean {
    let leader: Vehicle | undefined;
    let follower: Vehicle | undefined;
    for (const o of target.vehicles) {
      if (o.s >= veh.s) leader = o;
      else {
        follower = o;
        break;
      }
    }
    const aheadNeed = lerpNum(2 + veh.v * 0.5, 0.8, urgency);
    if (leader && leader.s - leader.length - veh.s < aheadNeed) return false;
    if (follower) {
      const behindNeed = lerpNum(3 + follower.v * 0.8, 1, urgency);
      if (veh.s - veh.length - follower.s < behindNeed) return false;
    }
    // Хвост ещё в начале полосы: не мешаем тем, кто въезжает в неё с манёвра.
    if (veh.s - veh.length < 6) {
      for (const m of this.graph.movesInto.get(target.id) ?? []) {
        for (const o of m.vehicles) if (m.length - o.s < 8) return false;
      }
    }
    return true;
  }

  private moveToLane(veh: Vehicle, from: GLane, to: GLane): void {
    queueRemove(from.vehicles, veh);
    insertSorted(to.vehicles, veh);
    veh.lateral += from.side - to.side;
    veh.lane = to.id;
    veh.planned = null;
    if (veh.waitingAt !== null) this.releaseNode(veh);
    const behind = to.vehicles[queueIndex(to.vehicles, veh) + 1];
    if (behind?.granted) this.revokeGrant(behind);
  }

  // ---------- Движение ----------

  /** Переход с полосы на следующую связь маршрута: продолжение полосы или манёвр с наименьшей очередью. */
  private pickMovement(veh: Vehicle, lane: GLane, routeIndex = veh.routeIndex): GMove | undefined {
    const own = routeIndex === veh.routeIndex && lane.id === veh.lane;
    if (own && veh.granted) return this.graph.moves.get(veh.granted);
    const next = veh.route[routeIndex + 1];
    if (next === undefined) return undefined;
    // Полоса выезда, с которой дальше по маршруту меньше перестраиваться, — лучше.
    const cost = this.lanePlan(veh)[routeIndex - veh.routeIndex + 1]?.cost;
    const outs = (this.graph.movesFrom.get(lane.id) ?? []).filter((m) => m.outLink === next);
    const easiest = Math.min(Infinity, ...outs.map((m) => cost?.get(m.outLane) ?? 0));
    let best: GMove | undefined;
    let bestScore = Infinity;
    for (const m of outs) {
      if (m.cont) return m;
      const out = this.graph.lanes.get(m.outLane);
      if (!out) continue;
      let score = out.vehicles.length * 3 + m.vehicles.length * 2;
      if ((cost?.get(out.id) ?? 0) > easiest + 1e-6) score += 40;
      if (own && m.key === veh.planned) score -= 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (own) veh.planned = best?.key ?? null;
    return best;
  }

  private computeAccel(veh: Vehicle, dt: number): number {
    if (veh.onMovement) {
      const aMax = veh.accel;
      const m = this.graph.moves.get(veh.onMovement)!;
      const idx = queueIndex(m.vehicles, veh);
      let gap = Infinity;
      let leaderV = 0;
      if (idx > 0) {
        const leader = m.vehicles[idx - 1];
        gap = leader.s - leader.length - veh.s;
        leaderV = leader.v;
      } else {
        const out = this.graph.lanes.get(m.outLane);
        const last = out?.vehicles[out.vehicles.length - 1];
        if (last) {
          gap = m.length - veh.s + last.s - last.length;
          leaderV = last.v;
        }
      }
      return idmAccel(veh.v, Math.min(m.speed, veh.maxSpeed), gap, veh.v - leaderV, aMax);
    }

    const lane = this.currentLane(veh)!;
    const idx = queueIndex(lane.vehicles, veh);
    // Изгиб впереди — тормозим заранее; на уклоне грузовики и автобусы медленнее (и разгоняются хуже).
    const prof = this.profile(lane);
    const k = Math.max(0, Math.min(prof.v.length - 1, Math.floor(veh.s / PROFILE_STEP)));
    const grade = prof.g[k];
    const heavy = veh.kind !== 'car';
    const curve = Math.min(prof.v[k], prof.v[Math.min(prof.v.length - 1, k + 1)]);
    let aMax = veh.accel;
    if (grade > 0 && heavy) aMax *= Math.max(0.35, 1 - 6 * grade);
    // Ждёт окна, чтобы перестроиться, — едет чуть медленнее соседнего потока.
    let desired = Math.min(lane.speed, curve, veh.maxSpeed * gradeFactor(grade, heavy)) * (1 - 0.3 * (veh.mergeWait ?? 0));
    // Закрытый переезд впереди на этой связи — как стоп-линия.
    const barrier = this.barrierAhead(lane.link, veh.centerS);
    const atBarrier = barrier < Infinity ? idmAccel(veh.v, desired, barrier + IDM.minGap - 0.5, veh.v, aMax) : Infinity;
    if (idx > 0) {
      // Впереди оказалась другая машина (въехала в полосу) — разрешение и место в очереди отдаём.
      if (veh.granted) this.revokeGrant(veh);
      if (veh.waitingAt !== null) this.releaseNode(veh);
      const leader = lane.vehicles[idx - 1];
      return Math.min(atBarrier, idmAccel(veh.v, desired, leader.s - leader.length - veh.s, veh.v - leader.v, aMax));
    }
    if (atBarrier < Infinity) return atBarrier;

    // Первая в полосе: смотрим вперёд по маршруту через продолжения полос — до лидера,
    // до перекрёстка, закрытого переезда или до конца пути.
    let ahead = lane.length - veh.s;
    let cur = lane;
    let ri = veh.routeIndex;
    for (let hop = 0; ; hop++) {
      if (ri === veh.route.length - 1) {
        // Маршрут оборван правкой и ждёт пересчёта: к разрыву не тормозит — до него новый маршрут будет (rerouteCuts).
        if (this.cuts.size && this.cuts.has(veh)) return idmAccel(veh.v, desired, Infinity, 0, aMax);
        return idmAccel(veh.v, desired, ahead + IDM.minGap + 1.5, veh.v, aMax);
      }
      const m = this.pickMovement(veh, cur, ri);
      if (!m) {
        // Полоса кончается, а перестроиться не вышло: стоим у её конца.
        if (cur === lane && ahead < 2 && veh.v < 0.5) {
          veh.stuckTimer += dt;
          if (veh.stuckTimer > 4) this.escapeWrongLane(veh, lane);
        }
        return idmAccel(veh.v, desired, ahead + IDM.minGap - 0.5, veh.v, aMax);
      }
      if (m.cont) {
        const out = this.graph.lanes.get(m.outLane)!;
        // Изгиб в начале следующей полосы — тоже тормозим заранее.
        desired = Math.min(desired, Math.sqrt(this.profile(out).v[0] ** 2 + IDM.brake * ahead));
        const last = out.vehicles[out.vehicles.length - 1];
        const bar = this.barrierAhead(out.link, null);
        if (bar < (last ? last.s - last.length : Infinity)) return idmAccel(veh.v, desired, ahead + bar + IDM.minGap - 0.5, veh.v, aMax);
        if (last) return idmAccel(veh.v, desired, ahead + last.s - last.length, veh.v - last.v, aMax);
        if (ahead > LOOKAHEAD || hop > 8) return idmAccel(veh.v, desired, Infinity, 0, aMax);
        ahead += out.length;
        cur = out;
        ri++;
        continue;
      }
      veh.stuckTimer = 0;
      desired = Math.min(desired, Math.sqrt(m.speed * m.speed + IDM.brake * ahead));
      // Проезд просим, только стоя в последней полосе перед узлом; дальше узел — как стоп-линия.
      if (cur !== lane) return idmAccel(veh.v, desired, ahead + IDM.minGap - 0.5, veh.v, aMax);
      if (veh.granted !== m.key && ahead <= this.grantLookahead(veh, m)) this.tryGrant(veh, m);
      let gap: number;
      let leaderV = 0;
      if (veh.granted === m.key) {
        gap = Infinity;
        const lastOnM = m.vehicles[m.vehicles.length - 1];
        if (lastOnM) {
          gap = ahead + lastOnM.s - lastOnM.length;
          leaderV = lastOnM.v;
        } else {
          const out = this.graph.lanes.get(m.outLane);
          const last = out?.vehicles[out.vehicles.length - 1];
          if (last) {
            gap = ahead + m.length + last.s - last.length;
            leaderV = last.v;
          }
        }
      } else {
        gap = ahead + IDM.minGap - 0.5;
      }
      return idmAccel(veh.v, desired, gap, veh.v - leaderV, aMax);
    }
  }

  /**
   * За сколько до узла просить проезд: без конфликтов, на главной и на зелёный, когда уступать некому (прямо, направо,
   * по стрелке), — заранее, чтобы не тормозить перед стоп-линией; иначе ближе.
   */
  private grantLookahead(veh: Vehicle, m: GMove): number {
    const stop = (veh.v * veh.v) / (2 * IDM.brake * 0.6) + 6;
    const node = this.graph.nodes.get(m.node!)!;
    const L = node.lights;
    const through = L
      ? this.lightAllows(node, m) && !L.phases[L.phase].yields.get(m.key)?.size
      : m.conflicts.size === 0 || node.priorityLanes.has(m.inLane);
    if (!through) return Math.max(stop, 8);
    const sStar = IDM.minGap + veh.v * IDM.headway + (veh.v * veh.v) / (2 * Math.sqrt(veh.accel * IDM.brake));
    return Math.max(stop, sStar * 3, 8);
  }

  /** Машина застряла не в той полосе: ищем объезд из текущей полосы. */
  private escapeWrongLane(veh: Vehicle, lane: GLane): void {
    veh.stuckTimer = 0;
    const exits = new Set<number>();
    for (const m of this.graph.movesFrom.get(lane.id) ?? []) exits.add(m.outLink);
    const starts = [...exits].map((id) => this.graph.links.get(id)!).filter(Boolean);
    const rest = findLaneRoute(this.graph, starts, veh.targetNode);
    if (rest) this.setRoute(veh, [lane.link, ...rest]);
    else this.lose(veh);
  }

  private integrate(veh: Vehicle, a: number, dt: number): void {
    veh.tripTime += dt;
    // Остановка через holdDist метров — как стоящая впереди машина.
    if (veh.holdDist !== undefined) a = Math.min(a, idmAccel(veh.v, veh.maxSpeed, veh.holdDist + IDM.minGap, veh.v, veh.accel));
    veh.v = Math.max(0, Math.min(veh.maxSpeed * 1.05, veh.v + a * dt));
    if (veh.holdDist !== undefined) {
      veh.v = Math.min(veh.v, veh.holdDist / dt);
      veh.holdDist = Math.max(0, veh.holdDist - veh.v * dt);
    }
    if (veh.v < 0.5) veh.stoppedTime += dt;
    veh.s += veh.v * dt;
    if (veh.lateral !== 0) {
      const step = Math.min(Math.abs(veh.lateral), (6 + veh.v * 0.2) * dt);
      veh.lateral -= Math.sign(veh.lateral) * step;
    }
    if (veh.onMovement) {
      const m = this.graph.moves.get(veh.onMovement)!;
      if (veh.s >= m.length) {
        queueRemove(m.vehicles, veh);
        const node = this.graph.nodes.get(m.node!);
        if (node) node.reserved = node.reserved.filter((x) => x !== veh);
        veh.s -= m.length;
        veh.onMovement = null;
        veh.planned = null;
        veh.routeIndex++;
        veh.lane = m.outLane;
        insertSorted(this.graph.lanes.get(m.outLane)!.vehicles, veh);
      }
    }
    // На коротких полосах за шаг можно проскочить несколько продолжений.
    for (let guard = 0; !veh.onMovement && guard < 8; guard++) {
      const lane = this.currentLane(veh)!;
      const isLast = veh.routeIndex === veh.route.length - 1;
      if (isLast && veh.s >= lane.length - 0.5) {
        if (this.events.dwell?.(veh)) {
          // Её отправили дальше (маршрут уже не кончается здесь) — едет без остановки; иначе стоит у конца полосы.
          if (veh.routeIndex === veh.route.length - 1) {
            veh.s = lane.length - 0.5;
            veh.v = 0;
          }
          break;
        }
        if (this.events.canArrive && !this.events.canArrive(veh)) {
          veh.s = lane.length - 0.5;
          veh.v = 0;
          break;
        }
        this.arrivals++;
        this.totalTripTime += veh.tripTime;
        this.remove(veh);
        this.events.onArrive(veh);
        return;
      }
      if (veh.s < lane.length) break;
      const m = veh.granted ? this.graph.moves.get(veh.granted) : this.pickMovement(veh, lane);
      if (m && lane.vehicles[0] === veh && (m.cont || veh.granted === m.key)) {
        queueShift(lane.vehicles);
        veh.s -= lane.length;
        veh.planned = null;
        if (m.cont) {
          veh.routeIndex++;
          veh.lane = m.outLane;
          insertSorted(this.graph.lanes.get(m.outLane)!.vehicles, veh);
          continue;
        }
        veh.onMovement = m.key;
        veh.granted = null;
        queuePush(m.vehicles, veh);
      } else {
        veh.s = lane.length;
        veh.v = 0;
      }
      break;
    }
    this.updatePose(veh);
  }

  /**
   * Курс кузова: задняя ось тянется за передней на длину базы — корма срезает угол на повороте. У машины из
   * двух частей так же за шарниром тянется вторая часть: полуприцеп за седлом тягача, задняя секция автобуса
   * за гармошкой (sim/body).
   */
  private steer(veh: Vehicle, pathDir: Vec): void {
    const base = veh.length * steerBase(veh.body);
    const front = veh.pos;
    let rear = veh.rear;
    const d = rear ? Math.hypot(front.x - rear.x, front.y - rear.y) : 0;
    if (!rear || d < base * 0.5 || d > base * 1.6) rear = { x: front.x - pathDir.x * base, y: front.y - pathDir.y * base };
    const dx = front.x - rear.x;
    const dy = front.y - rear.y;
    const l = Math.hypot(dx, dy);
    veh.dir = l < 1e-6 ? pathDir : { x: dx / l, y: dy / l };
    if (l >= 1e-6) veh.rear = { x: front.x - veh.dir.x * base, y: front.y - veh.dir.y * base };
    const hitch = hitchOf(veh.body);
    if (hitch) veh.trail = follow(jointOf(front, veh.dir, veh.length, hitch), veh.dir, veh.trail, veh.length * hitch.tail);
  }

  updatePose(veh: Vehicle): void {
    if (veh.onMovement) {
      const m = this.graph.moves.get(veh.onMovement);
      if (!m) return;
      const p = LaneGraph.pointOnMove(m, veh.s);
      veh.pos = p.pos;
      this.steer(veh, p.dir);
      if (m.node !== null) veh.level = this.graph.net.nodes.get(m.node)?.level ?? veh.level;
      // Корпус ещё (или уже) на полотне въезда или выезда — слой и его: у моста машина не ныряет под край.
      // Хвост — на целую длину позади носа.
      const half = veh.length / 2 + 1;
      let layer = layerOf(veh.level, veh.level);
      if (m.node === null || veh.s < veh.length + 1) layer = Math.max(layer, this.linkLayer(m.inLink));
      if (m.node === null || veh.s > m.length - half) layer = Math.max(layer, this.linkLayer(m.outLink));
      veh.layer = layer;
      return;
    }
    const lane = this.currentLane(veh);
    if (!lane) return;
    const pose = this.graph.lanePose(lane, Math.min(veh.s, lane.length));
    veh.pos = add(pose.pos, scale(rightNormal(pose.dir), veh.lateral));
    this.steer(veh, pose.dir);
    veh.centerS = this.graph.axisS(lane, veh.s);
    const net = this.graph.net;
    const link = this.graph.links.get(lane.link)!;
    const c = net.corridors.get(link.corridor);
    if (c) {
      veh.level = net.heightAt(c, veh.centerS);
      // На пандусе — в слое всего полотна (как его рисуют), иначе у начала моста машина ныряет под него.
      let layer = this.corridorLayer(c);
      // Корпус у стыка с мостом заходит на него — рисуем со слоем моста, а не под его краем (весь кузов, до хвоста).
      const on = bodyOnEnds(veh.centerS, veh.length, link.flow, c.length);
      for (const [id, near] of [
        [c.a, on.a],
        [c.b, on.b],
      ] as const) {
        const n = near ? net.nodes.get(id) : undefined;
        if (n?.kind === 'seam') for (const id2 of n.corridors) layer = Math.max(layer, this.corridorLayer(net.corridor(id2)));
      }
      veh.layer = layer;
    }
  }

  /** Слой отрисовки полотна (как у LaneRenderer): по высотам его концов. */
  private corridorLayer(c: Corridor): number {
    const la = this.graph.net.node(c.a).level;
    const lb = this.graph.net.node(c.b).level;
    return layerOf(Math.min(la, lb), Math.max(la, lb));
  }

  private linkLayer(linkId: number): number {
    const link = this.graph.links.get(linkId);
    const c = link && this.graph.net.corridors.get(link.corridor);
    return c ? this.corridorLayer(c) : -1;
  }

  // ---------- Проезд узлов ----------

  /** Зелёный ли этому манёвру (без светофора — всегда). */
  private lightAllows(node: GNode, m: GMove): boolean {
    const L = node.lights;
    if (!L) return true;
    return !L.clearing && L.phases[L.phase].moves.has(m.key);
  }

  /**
   * Сколько машин у узла (ближе 70 м к стоп-линии) хотят проехать по манёврам фазы, которым сейчас не зелёный
   * (now — манёвры, что зелёные сейчас: их уже пропускают, ради них переключаться незачем).
   */
  private phaseDemand(node: GNode, phase: LightPhase, now?: Set<string>): number {
    let demand = 0;
    const lanes = new Set<number>();
    for (const key of phase.moves) {
      const m = this.graph.moves.get(key);
      if (m) lanes.add(m.inLane);
    }
    for (const id of lanes) {
      const lane = this.graph.lanes.get(id)!;
      for (const veh of lane.vehicles) {
        if (lane.length - veh.s >= 70) continue;
        if (this.potentialMovements(veh, node.id).some((k) => phase.moves.has(k) && !now?.has(k))) demand++;
      }
    }
    return demand;
  }

  /** Светофоры: зелёный по фазам по кругу, между ними — жёлтый; «умный» пропускает пустые фазы и держит зелёный, пока никто не ждёт. */
  private updateLights(dt: number): void {
    for (const node of this.graph.nodes.values()) {
      const L = node.lights;
      if (!L) continue;
      L.timer -= dt;
      if (L.timer > 0) continue;
      const settings = this.graph.net.nodes.get(node.id);
      const adaptive = settings?.adaptive !== false;
      if (L.clearing) {
        L.clearing = false;
        for (let i = 1; i <= L.phases.length; i++) {
          const p = (L.phase + i) % L.phases.length;
          if (!adaptive || this.phaseDemand(node, L.phases[p]) > 0 || i === L.phases.length) {
            L.phase = p;
            break;
          }
        }
        L.timer = L.phases[L.phase].green;
      } else if (adaptive && !L.phases.some((p, i) => i !== L.phase && this.phaseDemand(node, p, L.phases[L.phase].moves) > 0)) {
        L.timer = 2;
      } else {
        L.clearing = true;
        L.timer = LIGHTS.clearance;
        this.stopForYellow(node);
      }
    }
  }

  /**
   * Загорелся жёлтый: кто получил проезд заранее, но ещё далеко и успевает спокойно остановиться, — останавливается
   * (иначе въедет на красный и задержит тех, кому уже зелёный). Близкие и уже въехавшие — проезжают.
   */
  private stopForYellow(node: GNode): void {
    for (const r of [...node.reserved]) {
      if (r.onMovement || !r.granted) continue;
      const lane = this.currentLane(r);
      const ahead = lane ? lane.length - r.s : 0;
      if (r.v < 1 || ahead > (r.v * r.v) / IDM.brake + 1) this.revokeGrant(r);
    }
  }

  private tryGrant(veh: Vehicle, m: GMove): boolean {
    const node = this.graph.nodes.get(m.node!)!;
    if (veh.waitingAt !== node.id) {
      if (veh.waitingAt !== null) this.releaseNode(veh);
      veh.waitingAt = node.id;
      veh.requestTime = this.time;
      node.waiting.push(veh);
    }
    const L = node.lights;
    // Фаза, по которой решается, кто кому уступает; на жёлтом — та, что кончается.
    const phase = L ? L.phases[L.phase] : null;
    // Налево на общий зелёный не дождались окна — стоящие у стоп-линии заканчивают поворот на жёлтый, пока встречные
    // стоят (иначе при плотном встречном потоке не повернуть никогда), — если успевают пересечь её до красного.
    const atLine = () => {
      const lane = this.currentLane(veh);
      const ahead = lane ? lane.length - veh.s : Infinity;
      // Когда доедет до линии — с запасом: разгоняется вполсилы (перед поворотом не разгоняются вовсю).
      const a = veh.accel / 2;
      const t = (Math.sqrt(veh.v * veh.v + 2 * a * ahead) - veh.v) / a;
      return ahead < LAST_CALL_REACH && t < L!.timer - 0.2;
    };
    const lastCall = !!L && L.clearing && !!phase!.yields.get(m.key)?.size && atLine();
    veh.ready = (this.lightAllows(node, m) || lastCall) && this.hasSpace(node, m, veh);
    if (!veh.ready) return false;
    // Подстраховка от зависших броней: держать узел может только машина на манёвре
    // или первая в своей полосе с действующим разрешением.
    node.reserved = node.reserved.filter((r) => {
      if (!this.vehicles.has(r.id)) return false;
      if (r.onMovement) return true;
      if (!r.granted) return false;
      const lane = this.currentLane(r);
      if (lane && lane.vehicles[0] === r) return true;
      r.granted = null;
      return false;
    });
    // В очереди — только те, кто стоит первым в своей полосе перед этим узлом.
    node.waiting = node.waiting.filter((w) => {
      const lane = this.currentLane(w);
      const link = lane && this.graph.links.get(lane.link);
      const ok = this.vehicles.has(w.id) && !w.onMovement && w.waitingAt === node.id && !!lane && lane.vehicles[0] === w && link?.toNode === node.id;
      if (!ok && w.waitingAt === node.id) w.waitingAt = null;
      return ok;
    });
    const isPriority = node.priorityLanes.has(m.inLane);
    const waited = this.time - veh.requestTime;
    // Кому уступаем по светофору (налево на общий зелёный — встречным). На жёлтом встречные стоят — некому.
    const yieldTo = phase && !lastCall ? phase.yields.get(m.key) : undefined;
    const window = lightYieldWindow(waited);
    // Бронь того, кто ещё далеко, — не помеха: если сами успеем проехать, его бронь снимем,
    // и он попросит проезд заново (на главной — заранее, чтобы не тормозить, поэтому брони там дальние).
    // Тому, кому уступаем (встречный на зелёный), — «далеко» по окну уступания, а не раньше.
    const soft: Vehicle[] = [];
    for (const r of node.reserved) {
      const rKey = r.onMovement ?? r.granted;
      if (!rKey || rKey === m.key) continue;
      const kind = m.conflicts.get(rKey);
      if (!kind) continue;
      if (kind === 'diverge' && r.onMovement && r.s > r.length + 3) continue;
      // Пересечение: тот уже целиком проехал общую зону — путь свободен.
      if (kind === 'cross' && r.onMovement) {
        const zone = this.graph.moves.get(r.onMovement)?.zones.get(m.key);
        if (zone && r.s - r.length > zone[1] + 1) continue;
      }
      // Вливание в ту же полосу: тот выедет на неё заметно раньше нас — поедем следом за ним.
      if (kind === 'merge' && r.onMovement) {
        const rm = this.graph.moves.get(r.onMovement);
        if (rm && rm.length - r.s + r.length + IDM.minGap < m.length - 4) continue;
      }
      if (!r.onMovement && this.etaToNode(r) > (yieldTo?.has(rKey) ? window : SOFT_GRANT) && this.etaToNode(veh) < 1.5) {
        soft.push(r);
        continue;
      }
      return false;
    }
    if (yieldTo?.size) {
      const lanes = new Set([...yieldTo].map((k) => this.graph.moves.get(k)?.inLane ?? -1));
      if (this.mustYield(node, m, lanes, yieldTo, window)) return false;
    }
    // Совсем заждавшегося на второстепенной пропускают: главная ждёт его по брони узла, как обычного.
    if (!L && node.priorityLanes.size && !isPriority && waited < COURTESY && this.mustYield(node, m, node.priorityLanes, null, waited > 15 ? 1.8 : 2.8)) return false;
    for (const w of node.waiting) {
      if (w === veh || !w.ready) continue;
      const wKey = w.planned;
      if (!wKey || wKey === m.key || !m.conflicts.has(wKey)) continue;
      if (phase) {
        // Светофор: кто уступает нам (налево навстречу) — не помеха; кому уступаем мы — помеха, даже подъехав позже.
        if (phase.yields.get(wKey)?.has(m.key)) continue;
        if (yieldTo?.has(wKey)) {
          if (this.etaToNode(w) <= window) return false;
          continue;
        }
      } else if (isPriority && !node.priorityLanes.has(w.lane)) continue;
      if (w.requestTime >= veh.requestTime - 0.05) continue;
      return false;
    }
    for (const r of soft) this.revokeGrant(r);
    veh.granted = m.key;
    node.waiting = node.waiting.filter((x) => x !== veh);
    veh.waitingAt = null;
    node.reserved.push(veh);
    return true;
  }

  /** Сколько секунд машине до конца её полосы (до узла) при нынешней скорости. */
  private etaToNode(v: Vehicle): number {
    const lane = this.currentLane(v);
    if (!lane) return 0;
    return (lane.length - v.s) / Math.max(v.v, 1);
  }

  /**
   * Уступить: кто-то с полос lanes (главной или встречной на светофоре) въедет в узел наперерез раньше, чем через
   * window секунд, — по манёвру из only (null — по любому). Ползущие в своей очереди — не помеха: если доползут,
   * их задержит бронь узла. Долго ждущий соглашается на меньший разрыв (window меньше).
   */
  private mustYield(node: GNode, m: GMove, lanes: Iterable<number>, only: Set<string> | null, window: number): boolean {
    const checked = new Set<number>();
    for (const pl of lanes) {
      for (const { veh, distance } of this.upstream(pl, 120)) {
        if (checked.has(veh.id)) continue;
        checked.add(veh.id);
        if (veh.v < 1 && !veh.onMovement) continue;
        if (distance > 8 && distance / veh.v > window) continue;
        for (const key of this.potentialMovements(veh, node.id)) {
          if (only && !only.has(key)) continue;
          const kind = m.conflicts.get(key);
          if (kind && kind !== 'diverge') return true;
        }
      }
    }
    return false;
  }

  /** Машины выше по потоку от конца полосы в пределах maxDist. */
  private upstream(laneId: number, maxDist: number): { veh: Vehicle; distance: number }[] {
    const result: { veh: Vehicle; distance: number }[] = [];
    const visit = (id: number, offset: number, depth: number) => {
      const lane = this.graph.lanes.get(id);
      if (!lane || offset > maxDist || depth > 6) return;
      for (const veh of lane.vehicles) result.push({ veh, distance: offset + lane.length - veh.s });
      const base = offset + lane.length;
      for (const mv of this.graph.movesInto.get(id) ?? []) {
        for (const veh of mv.vehicles) result.push({ veh, distance: base + mv.length - veh.s });
        visit(mv.inLane, base + mv.length, depth + 1);
      }
    };
    visit(laneId, 0, 0);
    return result;
  }

  /** Манёвры, которые машина может совершить в узле по своему маршруту. */
  private potentialMovements(veh: Vehicle, nodeId: number): string[] {
    for (let i = veh.routeIndex; i < veh.route.length - 1; i++) {
      const link = this.graph.links.get(veh.route[i]);
      if (link?.toNode !== nodeId) continue;
      if (i === veh.routeIndex && !veh.onMovement) {
        const key = veh.granted ?? veh.planned;
        if (key) return [key];
      }
      return (this.graph.transitions.get(`${veh.route[i]}>${veh.route[i + 1]}`) ?? []).map((mv) => mv.key);
    }
    return [];
  }

  private hasSpace(node: GNode, m: GMove, veh: Vehicle): boolean {
    const out = this.graph.lanes.get(m.outLane);
    if (!out) return false;
    let committed = 0;
    for (const r of node.reserved) {
      const rKey = r.onMovement ?? r.granted;
      const rm = rKey ? this.graph.moves.get(rKey) : undefined;
      if (rm && rm.outLane === out.id) committed += r.length + IDM.minGap;
    }
    const last = out.vehicles[out.vehicles.length - 1];
    const free = last ? last.s - last.length : out.length + veh.length + IDM.minGap;
    return free - committed >= (veh.length + IDM.minGap) * 0.6;
  }

  // ---------- Маршруты ----------

  private dynamicReroute(veh: Vehicle): void {
    if (veh.onMovement || veh.granted || veh.routeIndex >= veh.route.length - 1) return;
    const lane = this.currentLane(veh);
    const link = lane && this.graph.links.get(lane.link);
    if (!link) return;
    const route = findLaneRoute(this.graph, [link], veh.targetNode);
    if (route) this.setRoute(veh, route);
  }

  private setRoute(veh: Vehicle, routeFromCurrent: number[]): void {
    const oldNext = veh.route[veh.routeIndex + 1];
    veh.route = routeFromCurrent;
    veh.routeIndex = 0;
    if (oldNext !== veh.route[1] && !veh.onMovement) {
      this.revokeGrant(veh);
      veh.planned = null;
      if (veh.waitingAt !== null) this.releaseNode(veh);
    }
  }

  private lose(veh: Vehicle): void {
    this.remove(veh);
    this.events.onLost(veh);
  }
}

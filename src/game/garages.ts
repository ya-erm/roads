import { hash } from '../core/math';
import { add, dist, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import type { GLane, GLink, LaneGraph } from '../lanes/graph';
import type { LaneNet } from '../lanes/model';
import { findLaneRoute } from '../lanes/routing';
import type { LaneTraffic } from '../lanes/traffic';
import { steerBase } from '../sim/body';
import type { Vehicle, VehicleLook, VehicleSpec } from '../sim/vehicle';
import type { Town, TownBuilding } from '../world/entities';
import { drivewayLink, drivewayOf, type Driveway } from '../world/houseAccess';

/**
 * Машины частных домов — в гараже или на площадке у дома: часть поездок жителей начинается там или кончается там
 * (docs/DESIGN.md, «Машины жителей»). Выезд: машина задним ходом из гаража (ворота открыты) или с площадки по заезду
 * до бордюра, ждёт настоящего просвета на ближней полосе (LaneTraffic.clearToJoin), задним ходом с поворотом встаёт
 * на полосу носом по ходу и уезжает. Въезд: маршрут кончается связью у дома (Vehicle.endLink), машина
 * останавливается напротив заезда (holdAfter), с поворотником поворачивает в заезд передом и въезжает в гараж (за
 * воротами её не видно, ворота закрываются) или встаёт на площадку. Пока кузов над полосой — машина в потоке (стоит,
 * её объезжают и ждут, как стоящую), её рисуют там, где она на манёвре; во дворе — только рисунок.
 *
 * Тот же манёвр — у стоянок магазинов (game/shopParking.ts): место стоянки — такое же «место машины» (CarSpot), а
 * что делать, когда машина встала в поток или доехала до места, говорят крючки манёвра (MoveHooks).
 *
 * Всё решается без генератора случайных чисел партии: выезд ли это или возвращение — по seed, номеру поездки города
 * и хешу (Town.garageTrips), какая машина стоит у ворот и какого цвета — по хешу id дома. Дома с уехавшей машиной —
 * в городе (Town.garageAway), сохраняются с ним; манёвры, как и машины жителей в потоке, не сохраняются.
 */
export const GARAGE_TRIPS = {
  /**
   * Доля поездок из дома с машиной (машина дома, к заезду можно подъехать — slotOf), что начинаются в гараже или на
   * площадке: поездка из такого дома — почти всегда на своей машине. Гараж — у 45 % частных домов, площадка — у 35 %,
   * у дач — площадка у 40 % (world/houseAccess.CAR_PLACE); seed 7 — ~470 домов с машиной из 1294 жилых, подъехать
   * можно к ~90 %. Поездки начинаются в доме наугад: из гаража или с площадки — ~20 % всех поездок жителей, и
   * столько же — возвращений. На доме — выезд или въезд раз в ~2 минуты, на улице из 12 таких домов — раз в 10 с.
   */
  outShare: 0.5,
  /**
   * Поездка — возвращение домой с вероятностью away / (away + backK · домов с машиной в городе): чем больше машин в
   * разъездах, тем чаще они возвращаются. Равновесие (seed 7) — около трети машин в разъездах, возвращений столько
   * же, сколько выездов.
   */
  backK: 0.2,
  /** Сколько машина ждёт просвета у бордюра, с: не дождалась — передумала и заезжает обратно. */
  maxWait: 40,
  /**
   * Доля домов с гаражом, где перед воротами стоит вторая машина: ездит она (стоит первой), а та, что в гараже, —
   * нет. У остальных машина въезжает в гараж и дома её не видно.
   */
  secondCar: 0.2,
};

/**
 * Скорости манёвра, м/с игры (1 м/с — 2,2 км/ч): задним ходом во дворе и на полосу, передом с полосы в заезд и по
 * двору; разгон и торможение — мягкие, без рывка.
 */
const SPEED = { yardBack: 2.5, roadBack: 3.5, roadIn: 5, yardIn: 3, accel: 3, brake: 4 };
/** Место манёвра на полосе — не ближе стольких метров к её концам: там перекрёсток, стоп-линия, зебра. */
const END_ROOM = 10;
/** Перед выездом с бордюра машина стоит хотя бы столько, с (смотрит по сторонам), и столько — перед тем как тронуться. */
const LOOK = 0.8;
const PAUSE = 0.5;
/** Мягкое торможение, м/с² игры: подъезжая к заезду, позже этого уже не остановиться — проезжает мимо. */
const HOLD_BRAKE = 9;

/** Номер поездки города → зерно хеша: по seed партии, без общего генератора. */
function garageSeed(seed: number, town: number, n: number): number {
  return (Math.imul(seed >>> 0, 0x27d4eb2f) ^ Math.imul(town + 1, 0x165667b1) ^ Math.imul(n, 0x9e3779b1)) >>> 0;
}

/**
 * Место машины у здания: заезд и где она стоит — у дома (гараж, площадка) или на стоянке магазина. Центры кузова — у
 * машины носом к воротам (к дальнему краю места).
 */
export interface CarSpot {
  /** Ключ места: у дома — id дома, у места стоянки — отрицательный (shopParking.stallKey). */
  key: number;
  b: TownBuilding;
  d: Driveway;
  /** Машина стоит на виду — перед воротами, на площадке, на месте стоянки (иначе — в гараже, за воротами). */
  parks: boolean;
  color: string;
  /** Центр машины на месте (перед воротами, на площадке), в гараже и у бордюра (кузов в заезде, корма у полотна). */
  spot: Vec;
  inside: Vec;
  curbSide: Vec;
}

/** Дом с машиной: гараж (машина в нём или вторая — перед воротами) или открытая площадка. */
export interface GarageHome extends CarSpot {
  kind: 'garage' | 'pad';
}

/** Место машины по заезду: центры кузова на месте, в гараже и у бордюра. */
export function carSpot(key: number, b: TownBuilding, d: Driveway, parks: boolean, color: string, L: number): CarSpot {
  return {
    key,
    b,
    d,
    parks,
    color,
    spot: d.spot,
    inside: d.garage ? add(d.gate, scale(d.dir, L / 2 + 0.3)) : d.spot,
    curbSide: add(d.curb, scale(d.dir, L / 2 + 0.3)),
  };
}

/**
 * Что делать, когда манёвр дошёл до своей вехи: машина встала в поток (выезд), доехала до места (въезд), не
 * дождалась просвета и вернулась на место (выезд), не свернула к месту (проехала мимо, дорогу поменяли).
 */
export interface MoveHooks {
  joined?(sim: Vehicle): void;
  /** spot — место, куда встала (у стоянки — выбранное из свободных). */
  arrived?(spot: CarSpot): void;
  stayed?(): void;
  missed?(): void;
}

/** Машина в потоке едет к месту: куда (spot — пока не выбрано, — примерное, у стоянки), и можно ли выбрать другое. */
interface Homing {
  spot: CarSpot;
  town: Town;
  hooks: MoveHooks;
  /** Место занято за ней (busy). */
  reserved: boolean;
  /** Стоянка: свободные сейчас места — какое выбрать, решается, когда машина на полосе у них (нет — проезжает мимо). */
  choices?: () => CarSpot[];
}

/** Где машина встаёт на полосу (выезд) или с неё поворачивает (въезд) — на нынешнем графе. */
export interface GarageSlot {
  lane: GLane;
  link: GLink;
  /** Где на полосе центр машины в начале поворота в заезд и в конце выезда; нос — на полдлины дальше. */
  mid: number;
  /** Что заметает кузов на полосе: [от, до] по ходу. */
  zone: [number, number];
  /** Центр машины в mid и ход полосы. */
  pos: Vec;
  f: Vec;
}

/** Отрезок пути манёвра: точки центра кузова, касательные, задним ходом ли. */
interface Leg {
  pts: Vec[];
  tan: Vec[];
  cum: number[];
  len: number;
  back: boolean;
  vmax: number;
}

type Phase = 'yard' | 'wait' | 'road' | 'pause' | 'home';

/** Машина на манёвре у гаража, площадки или места стоянки. */
interface Move {
  home: CarSpot;
  town: Town;
  color: string;
  hooks: MoveHooks;
  kind: 'out' | 'in';
  phase: Phase;
  leg: Leg | null;
  /** Следующий отрезок (въезд: двор после полосы) — продолжает тем же ходом. */
  next: Leg | null;
  s: number;
  v: number;
  /** Машина в потоке, пока кузов над полосой. */
  sim?: Vehicle;
  wait: number;
  /** Въезд: поворотник к заезду. */
  blink?: -1 | 1;
  /** Выезд: куда едет и для карточки — откуда куда. */
  target?: number;
  /** Выезд: последняя связь маршрута (едет на стоянку магазина) и что делать, когда тронулась по полосе. */
  endLink?: number;
  then?: (sim: Vehicle) => void;
  trip?: { from: TownBuilding; to: TownBuilding };
}

/** Что игра даёт гаражам. */
export interface GarageHost {
  readonly seed: number;
  readonly traffic: LaneTraffic;
  readonly graph: LaneGraph;
  readonly net: LaneNet;
  /** Кузов машины жителя (без цвета). */
  readonly car: Omit<VehicleSpec, 'color'>;
  colors: readonly string[];
  /**
   * Машина со двора встала в поток: она — машина жителя (карточка: откуда куда), с этого мига — в счёте машин жителей
   * (до того, во дворе, — нет: в потоке её нет).
   */
  own(sim: Vehicle, trip: { from: TownBuilding; to: TownBuilding }): void;
  /** Машина жителя кончила поездку не у узла: сворачивая в гараж, ушла с полосы — снята с потока. */
  gone(sim: Vehicle): void;
}

/** Что решено о поездке жителя. */
export type GarageTrip = { kind: 'out'; home: GarageHome } | { kind: 'back'; home: GarageHome; slot: GarageSlot };

/**
 * Поправка к линии маршрута выбранной машины (Game.vehicleAhead) у места: head — начало вместо машины (выезд: от неё
 * задним ходом до полосы), anchor — откуда по полосам (иначе — от машины), tail — конец после полос (въезд: поворот
 * в заезд и до места), only — вся линия (машина уже сворачивает: полос впереди нет).
 */
export interface SpotAhead {
  head?: Vec[];
  anchor?: Vec;
  tail?: Vec[];
  only?: boolean;
}

/** Как нарисовать машину у гаража: кузов и, если она проезжает в ворота, — ворота (за ними её не видно, они открыты). */
export interface GarageLook {
  look: VehicleLook;
  gate?: { pos: Vec; dir: Vec; width: number };
}

function bezier(p0: Vec, p1: Vec, p2: Vec, p3: Vec, back: boolean, vmax: number, n = 18): Leg {
  const pts: Vec[] = [];
  const tan: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
    const d = {
      x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
      y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
    };
    const l = Math.hypot(d.x, d.y) || 1;
    tan.push({ x: d.x / l, y: d.y / l });
  }
  return finish(pts, tan, back, vmax);
}

function straight(a: Vec, b: Vec, back: boolean, vmax: number): Leg {
  const l = dist(a, b) || 1;
  const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  return finish([a, b], [t, t], back, vmax);
}

function finish(pts: Vec[], tan: Vec[], back: boolean, vmax: number): Leg {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, tan, cum, len: cum[cum.length - 1], back, vmax };
}

/** Центр кузова и курс (нос) на отрезке в s от его начала: задним ходом нос смотрит против хода. */
export function legPose(leg: Leg, s: number): { c: Vec; h: Vec } {
  const { pts, tan, cum } = leg;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const span = cum[i] - cum[i - 1];
  const t = span > 1e-9 ? Math.max(0, Math.min(1, (s - cum[i - 1]) / span)) : 1;
  const c = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
  const hx = tan[i - 1].x + (tan[i].x - tan[i - 1].x) * t;
  const hy = tan[i - 1].y + (tan[i].y - tan[i - 1].y) * t;
  const l = Math.hypot(hx, hy) || 1;
  const k = leg.back ? -1 / l : 1 / l;
  return { c, h: { x: hx * k, y: hy * k } };
}

export class Garages {
  /** Дом → его гараж или площадка (геометрия не меняется; null — места для машины нет). */
  private homes = new Map<number, GarageHome | null>();
  /** Дома с машиной в городе — для рисунка машин у ворот и счёта: по массиву домов города. */
  private towns = new Map<number, { of: TownBuilding[]; n: number; list: GarageHome[]; byId: Map<number, GarageHome>; box: [number, number, number, number] }>();
  /** Где машина встаёт на полосу — по ключу места, по нынешнему графу (сменился — заново, по мере надобности). */
  private slots = new Map<number, GarageSlot | null>();
  private slotGraph: LaneGraph | null = null;
  /** Машины на манёвре и те, что едут к своему месту (id машины в потоке → место). */
  readonly moves: Move[] = [];
  private homing = new Map<number, Homing>();
  /** Места (ключи), чья машина сейчас на манёвре или едет к ним. */
  private busy = new Set<number>();

  constructor(private host: GarageHost) {}

  /**
   * Место машины дома: гараж (машина въезжает в него; у части домов вторая — перед воротами) или площадка, её цвет.
   * Нет ни того ни другого (не частный дом или дача, второй ряд, без машины) — null.
   */
  homeOf(b: TownBuilding): GarageHome | null {
    let h = this.homes.get(b.id);
    if (h !== undefined) return h;
    const d = drivewayOf(b);
    h = null;
    if (d) {
      const colors = this.host.colors;
      const parks = !d.garage || hash(b.id, 18) < GARAGE_TRIPS.secondCar;
      const spot = carSpot(b.id, b, d, parks, colors[Math.floor(hash(b.id, 29) * colors.length)], this.host.car.length);
      h = { ...spot, kind: d.garage ? 'garage' : 'pad' };
    }
    this.homes.set(b.id, h);
    return h;
  }

  /** Занято ли место: его машина на манёвре или едет к нему. */
  isBusy(key: number): boolean {
    return this.busy.has(key);
  }

  /** Гаражи города (по его домам; дома прибавились или убавились — заново). */
  private townHomes(town: Town) {
    const hit = this.towns.get(town.id);
    if (hit && hit.of === town.buildings && hit.n === town.buildings.length) return hit;
    const list: GarageHome[] = [];
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const b of town.buildings) {
      const h = b.kind === 'res' ? this.homeOf(b) : null;
      if (!h) continue;
      list.push(h);
      box[0] = Math.min(box[0], h.spot.x);
      box[1] = Math.min(box[1], h.spot.y);
      box[2] = Math.max(box[2], h.spot.x);
      box[3] = Math.max(box[3], h.spot.y);
    }
    const entry = { of: town.buildings, n: town.buildings.length, list, byId: new Map(list.map((h) => [h.b.id, h])), box };
    this.towns.set(town.id, entry);
    return entry;
  }

  /** Сколько гаражей в городе. */
  count(town: Town): number {
    return this.townHomes(town).list.length;
  }

  /**
   * Где машина гаража встаёт на полосу и с неё сворачивает — на нынешнем графе: крайняя правая полоса своего хода
   * у бордюра со стороны дома (на односторонней с домом слева — нет), место поворота — на радиус поворота раньше
   * заезда, не ближе END_ROOM к концам полосы. Нельзя (дорогу снесли, заезд у перекрёстка, полоса дальше 25 м) — null.
   */
  slotOf(home: CarSpot): GarageSlot | null {
    const g = this.host.graph;
    if (this.slotGraph !== g) {
      this.slots.clear();
      this.slotGraph = g;
    }
    let s = this.slots.get(home.key);
    if (s !== undefined) return s;
    s = this.computeSlot(home, g);
    this.slots.set(home.key, s);
    return s;
  }

  private computeSlot(home: CarSpot, g: LaneGraph): GarageSlot | null {
    const net = this.host.net;
    const at = drivewayLink(net, home.d);
    const c = at && net.corridors.get(at.corridor);
    if (!at || !c) return null;
    const { point, tangent } = c.lut.frameAt(at.s);
    const lat = dot(sub(home.d.curb, point), rightNormal(tangent));
    let best: { lane: GLane; link: GLink } | null = null;
    for (const link of g.corridorLinks(at.corridor)) {
      if (at.s < link.s0 || at.s > link.s1 || link.toNode === null) continue;
      const lane = link.lanes[link.lanes.length - 1];
      if (!lane || Math.sign(lane.offset) !== Math.sign(lat) || Math.abs(lane.offset) >= Math.abs(lat)) continue;
      if (!best || Math.abs(lane.offset) > Math.abs(best.lane.offset)) best = { lane, link };
    }
    if (!best) return null;
    const { lane, link } = best;
    const L = this.host.car.length;
    const W = this.host.car.width;
    const uc = link.flow > 0 ? at.s - link.s0 : link.s1 - at.s;
    const q = g.lanePose(lane, uc);
    // Заезд почти поперёк полосы — иначе поворот в него не по дуге.
    if (Math.abs(dot(home.d.dir, q.dir)) > 0.5) return null;
    const rel = sub(home.curbSide, q.pos);
    const lon = dot(rel, q.dir);
    const a = Math.abs(dot(rel, rightNormal(q.dir)));
    const mid = uc + lon - a;
    const zone: [number, number] = [mid - L / 2 - 0.5, uc + lon + W / 2 + 1];
    if (zone[0] < END_ROOM || zone[1] > lane.length - END_ROOM) return null;
    const p = g.lanePose(lane, mid);
    return { lane, link, mid, zone, pos: p.pos, f: p.dir };
  }

  /**
   * Поездка жителя из дома origin города town: возвращение машины домой (дом из уехавших), выезд из гаража или с
   * площадки (дома origin, если там машина, иначе — другого дома города с машиной на месте) или обычная (null). Номер
   * поездки — в городе (Town.garageTrips), решение — по хешу от него и seed партии.
   */
  trip(town: Town, origin: TownBuilding): GarageTrip | null {
    const n = (town.garageTrips = (town.garageTrips ?? 0) + 1);
    const seed = garageSeed(this.host.seed, town.id, n);
    const r = (k: number) => hash(seed, k);
    const homes = this.townHomes(town);
    const away = town.garageAway;
    if (away?.length) {
      const free = away.filter((id) => !this.busy.has(id));
      if (free.length && r(1) < free.length / (free.length + GARAGE_TRIPS.backK * Math.max(1, homes.list.length))) {
        const id = free[Math.floor(r(2) * free.length)];
        const home = homes.byId.get(id);
        const slot = home && this.slotOf(home);
        if (home && slot) return { kind: 'back', home, slot };
        // Дома нет или к нему не подъехать: машина вернулась незаметно.
        town.garageAway = away.filter((x) => x !== id);
      }
    }
    if (r(3) >= GARAGE_TRIPS.outShare || !homes.list.length) return null;
    const out = town.garageAway?.length ? new Set(town.garageAway) : null;
    const ready = (h: GarageHome | null): h is GarageHome => !!h && !this.busy.has(h.key) && !out?.has(h.b.id) && !!this.slotOf(h);
    const own = origin.kind === 'res' ? this.homeOf(origin) : null;
    if (ready(own)) return { kind: 'out', home: own };
    // Из дома без машины (или она в разъездах) — едет машина другого дома города: несколько попыток по хешу.
    for (let i = 0; i < 4; i++) {
      const h = homes.list[Math.floor(r(4 + i) * homes.list.length)];
      if (ready(h)) return { kind: 'out', home: h };
    }
    return null;
  }

  /** Геометрия места сменилась (магазин перестроили): где вставать на полосу — заново. */
  forgetSlot(key: number): void {
    this.slots.delete(key);
  }

  /** Крючки манёвра машины дома: уехала — в разъездах (Town.garageAway), вернулась — дома. */
  private homeHooks(home: CarSpot, town: Town): MoveHooks {
    return {
      joined: () => {
        const away = (town.garageAway ??= []);
        if (!away.includes(home.b.id)) away.push(home.b.id);
      },
      arrived: () => {
        const away = town.garageAway;
        if (away) town.garageAway = away.filter((id) => id !== home.b.id);
      },
    };
  }

  /**
   * Машина выезжает из гаража (или от ворот, с площадки, с места стоянки — home) к узлу target: задним ходом к
   * бордюру, там ждёт просвета. trip — откуда куда (для карточки). opt: color и hooks — у места стоянки (у дома —
   * свои); endLink — маршрут кончается этой связью (едет на стоянку магазина), then — встала на полосу и поехала.
   */
  leave(
    home: CarSpot,
    town: Town,
    target: number,
    trip: { from: TownBuilding; to: TownBuilding },
    opt: { color?: string; hooks?: MoveHooks; endLink?: number; then?: (sim: Vehicle) => void } = {},
  ): void {
    const start = home.parks ? home.spot : home.inside;
    this.busy.add(home.key);
    this.moves.push({
      home,
      town,
      color: opt.color ?? home.color,
      hooks: opt.hooks ?? this.homeHooks(home, town),
      then: opt.then,
      kind: 'out',
      phase: 'yard',
      leg: straight(start, home.curbSide, true, SPEED.yardBack),
      next: null,
      s: 0,
      v: 0,
      wait: 0,
      target,
      endLink: opt.endLink,
      trip,
    });
  }

  /** Маршрут к гаражу: от узла from, последней — связь у дома (Vehicle.endLink). Не доехать — null. */
  routeHome(from: number, slot: GarageSlot): number[] | null {
    const g = this.host.graph;
    return findLaneRoute(g, g.outLinks.get(from) ?? [], slot.link.toNode!, slot.link.id);
  }

  /** Машина в потоке sim везёт машину дома домой: маршрут уже к связи у дома (routeHome). */
  homeward(sim: Vehicle, home: CarSpot, town: Town, slot: GarageSlot): void {
    sim.endLink = slot.link.id;
    this.homing.set(sim.id, { spot: home, town, hooks: this.homeHooks(home, town), reserved: true });
    this.busy.add(home.key);
  }

  /**
   * Машина в потоке sim едет на стоянку: маршрут — к связи у места planned (routeHome); какое место из свободных
   * (choices) занять, решается на полосе у стоянки — нет свободного, проезжает мимо (hooks.missed).
   */
  toStall(sim: Vehicle, planned: CarSpot, town: Town, slot: GarageSlot, hooks: MoveHooks, choices: () => CarSpot[]): void {
    sim.endLink = slot.link.id;
    this.homing.set(sim.id, { spot: planned, town, hooks, reserved: false, choices });
  }

  /** Едет ли машина к своему месту и уже встаёт напротив заезда — тогда прижимается к бордюру (events.curbStop). */
  pulls(sim: Vehicle): boolean {
    return sim.holdDist !== undefined && this.homing.has(sim.id);
  }

  /** Машина в потоке кончила поездку или потерялась (не у места): место её больше не ждёт. */
  forget(simId: number): void {
    const h = this.homing.get(simId);
    if (!h) return;
    this.homing.delete(simId);
    if (h.reserved) this.busy.delete(h.spot.key);
    h.hooks.missed?.();
  }

  /** Такт — после движения (traffic.step): машины на манёвре — туда, где они на нём. */
  step(dt: number): void {
    if (this.homing.size) this.stepHoming();
    for (let i = 0; i < this.moves.length; i++) {
      if (this.stepMove(this.moves[i], dt)) continue;
      this.moves.splice(i--, 1);
    }
  }

  /** Подъезжающие к своему месту: напротив заезда — остановиться, остановились — повернуть в него. */
  private stepHoming(): void {
    const traffic = this.host.traffic;
    for (const [id, h] of [...this.homing]) {
      const sim = traffic.vehicles.get(id);
      if (!sim) {
        this.forget(id);
        continue;
      }
      const slot = this.slotOf(h.spot);
      // Дорогу поменяли — связи у места больше нет: едет просто к узлу (её endLink уже снят или не тот).
      if (!slot || sim.endLink !== slot.link.id) {
        this.cancelHoming(sim);
        continue;
      }
      if (sim.holdDist === undefined) {
        const lane = sim.onMovement ? undefined : traffic.currentLane(sim);
        if (!lane || lane.link !== slot.link.id) continue;
        // Поздно останавливаться — проехала мимо: поездка кончится у узла.
        const late = (s: GarageSlot) => s.mid + sim.length / 2 - sim.s < (sim.v * sim.v) / (2 * HOLD_BRAKE) + 0.5;
        // Не в крайней полосе (широкая улица) — сначала перестроится к бордюру (на последней связи пути машина сама
        // держится правее), а остановка (holdAfter) запретила бы ей перестраиваться.
        if (lane.id !== slot.lane.id) {
          if (late(slot)) this.cancelHoming(sim);
          continue;
        }
        if (h.choices) {
          // Стоянка: ближнее из свободных мест, до которого ещё успеть остановиться; нет — мимо.
          let best: { spot: CarSpot; slot: GarageSlot } | null = null;
          for (const c of h.choices()) {
            const s = this.slotOf(c);
            if (!s || s.lane.id !== slot.lane.id || this.busy.has(c.key) || late(s)) continue;
            if (!best || s.mid < best.slot.mid) best = { spot: c, slot: s };
          }
          if (!best) {
            this.cancelHoming(sim);
            continue;
          }
          h.spot = best.spot;
          h.reserved = true;
          this.busy.add(best.spot.key);
          traffic.holdAfter(sim, best.slot.mid + sim.length / 2 - sim.s);
          continue;
        }
        if (late(slot)) this.cancelHoming(sim);
        else traffic.holdAfter(sim, slot.mid + sim.length / 2 - sim.s);
        continue;
      }
      // Встаёт напротив заезда — с поворотником к нему.
      const blink = dot(h.spot.d.dir, rightNormal(slot.f)) > 0 ? 1 : -1;
      sim.blinker = blink;
      if (!traffic.held(sim)) continue;
      if (sim.lane !== slot.lane.id) {
        this.cancelHoming(sim);
        continue;
      }
      this.homing.delete(id);
      const c0 = sub(sim.pos, scale(sim.dir, sim.length / 2));
      const legs = this.inLegs(h.spot, c0, sim.dir);
      sim.lcCooldown = 1e9;
      this.moves.push({
        home: h.spot,
        town: h.town,
        color: sim.color,
        hooks: h.hooks,
        kind: 'in',
        phase: 'road',
        leg: legs[0],
        next: legs[1],
        s: 0,
        v: 0,
        sim,
        wait: 0,
        blink,
      });
    }
  }

  /** Въезд с полосы: поворот от центра кузова c0 (курс f) к бордюру и по заезду до места или в гараж. */
  private inLegs(home: CarSpot, c0: Vec, f: Vec): [Leg, Leg] {
    const end = home.curbSide;
    const k = 0.55 * Math.max(2, Math.abs(dot(sub(end, c0), rightNormal(f))));
    return [
      bezier(c0, add(c0, scale(f, k)), sub(end, scale(home.d.dir, k)), end, false, SPEED.roadIn),
      straight(end, home.parks ? home.spot : home.inside, false, SPEED.yardIn),
    ];
  }

  /** Едет к месту, но к нему не свернёт (дорогу поменяли, проехала мимо): поездка кончается у узла, как у всех. */
  private cancelHoming(sim: Vehicle): void {
    delete sim.endLink;
    if (sim.holdDist !== undefined) this.host.traffic.release(sim);
    this.forget(sim.id);
  }

  /** Шаг манёвра; false — кончился. */
  private stepMove(m: Move, dt: number): boolean {
    const traffic = this.host.traffic;
    // Машину в потоке сняли (потерялась при правке сети) — и манёвра больше нет.
    if (m.sim && !traffic.vehicles.has(m.sim.id)) return this.done(m);
    if (m.phase === 'wait') return this.stepWait(m, dt);
    if (m.phase === 'pause') {
      m.wait += dt;
      this.pose(m);
      if (m.wait < PAUSE) return true;
      // Встала на полосу носом по ходу — поехала.
      const sim = m.sim!;
      traffic.release(sim);
      sim.lcCooldown = 0.5;
      m.then?.(sim);
      return this.done(m);
    }
    const leg = m.leg!;
    const ahead = leg.len - m.s + (m.next && m.next.back === leg.back ? m.next.len : 0);
    m.v = Math.max(0.3, Math.min(leg.vmax, m.v + SPEED.accel * dt, Math.sqrt(2 * SPEED.brake * Math.max(0, ahead))));
    m.s += m.v * dt;
    if (m.s >= leg.len) {
      const over = m.s - leg.len;
      if (!this.legDone(m)) return this.done(m);
      if (m.leg && m.leg !== leg) m.s = m.leg.back === leg.back ? Math.min(over, m.leg.len) : 0;
    }
    this.pose(m);
    return true;
  }

  /** Отрезок пройден — следующая фаза; false — манёвр кончился. */
  private legDone(m: Move): boolean {
    const leg = m.leg!;
    m.s = leg.len;
    if (m.kind === 'out' && m.phase === 'yard') {
      m.phase = 'wait';
      m.wait = 0;
      m.v = 0;
      return true;
    }
    if (m.kind === 'out' && m.phase === 'road') {
      m.phase = 'pause';
      m.wait = 0;
      m.v = 0;
      return true;
    }
    if (m.kind === 'in' && m.phase === 'road') {
      // Кузов ушёл с полосы в заезд — поездка в потоке кончилась.
      const sim = m.sim!;
      const traffic = this.host.traffic;
      traffic.remove(sim);
      traffic.arrivals++;
      traffic.totalTripTime += sim.tripTime;
      this.host.gone(sim);
      m.sim = undefined;
      m.phase = 'yard';
      m.leg = m.next;
      m.next = null;
      return true;
    }
    // Доехала до места (въезд) или передумала и вернулась (выезд): машина на месте.
    if (m.kind === 'in') m.hooks.arrived?.(m.home);
    else m.hooks.stayed?.();
    return false;
  }

  /** Ждёт у бордюра просвета; дождалась — встаёт в поток (стоит, пока выезжает). */
  private stepWait(m: Move, dt: number): boolean {
    m.wait += dt;
    const slot = this.slotOf(m.home);
    const giveUp = !slot || m.wait > GARAGE_TRIPS.maxWait;
    if (!giveUp && (m.wait < LOOK || !this.host.traffic.clearToJoin(slot.lane.id, slot.zone[0], slot.zone[1]))) return true;
    const L = this.host.car.length;
    const sim = giveUp ? null : this.host.traffic.placeOnLane({ ...this.host.car, color: m.color, targetNode: m.target!, endLink: m.endLink }, slot.lane.id, slot.mid + L / 2);
    if (!sim || !slot) {
      // Не дождалась (или ехать некуда) — обратно на место.
      m.phase = 'home';
      m.leg = straight(m.home.curbSide, m.home.parks ? m.home.spot : m.home.inside, false, SPEED.yardIn);
      m.s = 0;
      m.v = 0;
      return true;
    }
    const traffic = this.host.traffic;
    traffic.holdAfter(sim, 0);
    // Едет на стоянку магазина: путь кончается связью у неё — сразу, а не когда тронется (иначе, пересчитав путь на
    // манёвре, она поехала бы просто к узлу, а связь у стоянки разошлась бы с концом пути).
    if (m.endLink !== undefined) sim.endLink = m.endLink;
    sim.lcCooldown = 1e9;
    this.host.own(sim, m.trip!);
    m.hooks.joined?.(sim);
    const start = m.home.curbSide;
    const k = 0.55 * Math.max(2, Math.abs(dot(sub(start, slot.pos), rightNormal(slot.f))));
    m.sim = sim;
    m.phase = 'road';
    m.leg = bezier(start, sub(start, scale(m.home.d.dir, k)), add(slot.pos, scale(slot.f, k)), slot.pos, true, SPEED.roadBack);
    m.s = 0;
    m.v = 0;
    this.pose(m);
    return true;
  }

  private done(m: Move): false {
    this.busy.delete(m.home.key);
    return false;
  }

  /** Машина в потоке на манёвре — там, где она на нём (поток её держит на месте: holdAfter). */
  private pose(m: Move): void {
    const sim = m.sim;
    if (!sim || !m.leg) return;
    const { c, h } = legPose(m.leg, m.s);
    const nose = add(c, scale(h, sim.length / 2));
    sim.pos = nose;
    sim.dir = h;
    sim.rear = sub(nose, scale(h, steerBase(sim.body) * sim.length));
    sim.v = 0;
    sim.blinker = m.blink ?? 0;
  }

  /**
   * Машина места key (у дома — id дома) на манёвре: нос, курс, фаза и машина в потоке (пока кузов над полосой). Нет
   * манёвра — null.
   */
  moveOf(key: number): { pos: Vec; dir: Vec; phase: Phase; kind: 'out' | 'in'; sim?: Vehicle } | null {
    const m = this.moves.find((x) => x.home.key === key);
    if (!m) return null;
    if (m.sim) return { pos: m.sim.pos, dir: m.sim.dir, phase: m.phase, kind: m.kind, sim: m.sim };
    const { c, h } = legPose(m.leg!, m.s);
    return { pos: add(c, scale(h, this.host.car.length / 2)), dir: h, phase: m.phase, kind: m.kind };
  }

  /** Едет ли машина в потоке к своему месту (и какому: у дома — id дома). */
  homingOf(simId: number): number | undefined {
    return this.homing.get(simId)?.spot.key;
  }

  /**
   * Линия маршрута выбранной машины у места (SpotAhead): едет к месту — по полосам до поворота и дальше поворот,
   * заезд и место (нос машины); уже сворачивает — только это; выезжает задним ходом — от неё до полосы и дальше по
   * маршруту. Ни то ни другое — null.
   */
  aheadOf(simId: number): SpotAhead | null {
    const L = this.host.car.length;
    const nose = (leg: Leg, from: number): Vec[] => {
      const out: Vec[] = [];
      for (let i = 0; i < leg.cum.length; i++) {
        if (leg.cum[i] <= from) continue;
        const { c, h } = legPose(leg, leg.cum[i]);
        out.push(add(c, scale(h, L / 2)));
      }
      return out;
    };
    const m = this.moves.find((x) => x.sim?.id === simId);
    if (m) {
      const sim = m.sim!;
      if (m.kind === 'in') return { only: true, tail: [sim.pos, ...nose(m.leg!, m.s), ...(m.next ? nose(m.next, 0) : [])] };
      const slot = this.slotOf(m.home);
      if (!slot) return null;
      const anchor = add(slot.pos, scale(slot.f, L / 2));
      return { head: [sim.pos, anchor], anchor };
    }
    const h = this.homing.get(simId);
    const slot = h && this.slotOf(h.spot);
    if (!h || !slot) return null;
    const [turn, yard] = this.inLegs(h.spot, slot.pos, slot.f);
    return { tail: [add(slot.pos, scale(slot.f, L / 2)), ...nose(turn, 0), ...nose(yard, 0)] };
  }

  /**
   * Машины у гаражей в кадре: стоящие у ворот (кроме тех, что уехали или на манёвре) — если parked, и на манёвре во
   * дворе (в потоке их рисует поток). box — [x0, y0, x1, y1] кадра.
   */
  looks(towns: readonly Town[], box: [number, number, number, number], parked: boolean): GarageLook[] {
    const out: GarageLook[] = [];
    const spec = this.host.car;
    const inBox = (p: Vec, pad = 0) => p.x > box[0] - pad && p.x < box[2] + pad && p.y > box[1] - pad && p.y < box[3] + pad;
    if (parked) {
      for (const town of towns) {
        const t = this.townHomes(town);
        const b = t.box;
        if (!t.list.length || b[2] < box[0] - 10 || b[0] > box[2] + 10 || b[3] < box[1] - 10 || b[1] > box[3] + 10) continue;
        const away = town.garageAway?.length ? new Set(town.garageAway) : null;
        for (const h of t.list) {
          if (!h.parks || this.busy.has(h.key) || away?.has(h.b.id) || !inBox(h.spot, 10)) continue;
          out.push({ look: { ...spec, color: h.color, pos: add(h.spot, scale(h.d.dir, spec.length / 2)), dir: h.d.dir } });
        }
      }
    }
    for (const m of this.moves) {
      if (m.sim || !m.leg) continue;
      const { c, h } = legPose(m.leg, m.s);
      if (!inBox(c, 10)) continue;
      const look: VehicleLook = { ...spec, color: m.color, pos: add(c, scale(h, spec.length / 2)), dir: h };
      out.push(m.home.parks ? { look } : { look, gate: { pos: m.home.d.gate, dir: m.home.d.dir, width: m.home.d.width } });
    }
    return out;
  }
}

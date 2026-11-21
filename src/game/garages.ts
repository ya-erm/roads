import { hash } from '../core/math';
import { add, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import type { GLane, GLink, LaneGraph } from '../lanes/graph';
import type { LaneNet } from '../lanes/model';
import { findLaneRoute, routeCost } from '../lanes/routing';
import { centreLine } from '../lanes/solid';
import type { Barrier, LaneTraffic, TrafficActivity } from '../lanes/traffic';
import {
  advance,
  bezier,
  decideNow,
  entrySpeed,
  handOff,
  joinLane,
  leaveFlow,
  legPose,
  path,
  poseSim,
  reversed,
  runOf,
  runPose,
  straight,
  type Leg,
  type Run,
} from './lotMoves';
import type { Vehicle, VehicleLook, VehicleSpec } from '../sim/vehicle';
import type { Town, TownBuilding } from '../world/entities';
import { drivewayLink, drivewayOf, type Driveway } from '../world/houseAccess';
import { isTrunk, LANE_W } from '../world/roadTypes';
import { homeExit } from './homeExit';
import { boxesOverlap, type Box } from '../lanes/curb';

/**
 * Машины частных домов — в гараже или на площадке у дома: часть поездок жителей начинается там или кончается там
 * (docs/DESIGN.md, «Машины жителей»). Выезд из закрытого гаража — передом (разворот скрыт внутри); на открытом участке
 * сначала разворачивается в свободном дворе и выравнивается по заезду. В тесноте — задним ходом только на ближайшую
 * полосу, в настоящий просвет (LaneTraffic.clearToJoin), затем пауза на переключение хода. Поворотник — при подъезде
 * к дороге, не при развороте во дворе. Въезд: маршрут кончается связью у дома (Vehicle.endLink), машина заранее сбрасывает скорость до скорости
 * поворота в заезд (LaneTraffic.slowTo, lotMoves.entrySpeed) и с поворотником сворачивает в него с ходу, передом, —
 * в гараж (за воротами её не видно, ворота закрываются) или на площадку. Встаёт напротив заезда она, только если
 * поворачивать налево, а встречка занята (LEFT_TURN). Пока кузов над полосой — машина в потоке (стоит, её
 * объезжают и ждут, как стоящую), её рисуют там, где она на манёвре; во дворе — только рисунок.
 *
 * Тот же манёвр — у стоянок магазинов (game/shopParking.ts): место стоянки — такое же «место машины» (CarSpot), а
 * что делать, когда машина встала в поток или доехала до места, говорят крючки манёвра (MoveHooks).
 *
 * Здесь — только манёвр: кто когда выезжает и куда возвращается, решает парк машин жителей (game/carHomes.ts:
 * CarHomes.trip, место ночёвки, Town.cars) — своего учёта поездок (прежние Town.garageTrips, garageAway) у гаражей
 * больше нет; при загрузке старого сохранения он переносится в парк. Крючки по умолчанию (homeHooks) отмечают дом с
 * уехавшей машиной в Town.garageAway — только для прямого вызова манёвра (тесты): игра всегда передаёт свои.
 * Манёвры, как и машины жителей в потоке, не сохраняются.
 */
export const GARAGE_TRIPS = {
  /** Сколько машина ждёт просвета у бордюра, с: не дождалась — передумала и заезжает обратно. */
  maxWait: 40,
  /**
   * Доля домов с гаражом, где перед воротами стоит вторая машина: ездит она (стоит первой), а та, что в гараже, —
   * нет. У остальных машина въезжает в гараж и дома её не видно.
   */
  secondCar: 0.2,
};

/**
 * Левый поворот к дому, гаражу, площадке или стоянке через встречку — только через прерывистую осевую: на улице и
 * грунтовке 1+1, не у перекрёстка (lanes/solid.centreLine — по ней же рисуется разметка). Через жёлтую осевую
 * (проспект 2+2 и шире), белую сплошную у перекрёстка, разделитель, на шоссе и магистрали и на односторонней — только
 * направо (GarageSlot.cross). Машина с левым поворотником сбрасывает скорость до скорости поворота и за тормозной
 * путь до него смотрит на встречку: встречному должно хватать места спокойно остановиться (LaneTraffic.clearToJoin —
 * 66 м на 50 км/ч), пока она пересекает встречку по дуге (~4 с: встречку на это время закрывает стоп-линия,
 * LaneTraffic.turnStops). Хватает — поворачивает с ходу; нет — встаёт на своей полосе напротив заезда и ждёт
 * просвета. Сзади на её полосе ждут — как в жизни. Выезд — так же: задним ходом через ближнюю полосу в дальнюю, когда
 * просвет в обеих.
 */
export const LEFT_TURN = {
  /** Сколько машина ждёт просвета, чтобы свернуть налево к месту, с: не дождалась — в объезд, к повороту направо. */
  maxWait: 25,
  /** Сколько машина у бордюра ждёт просвета в обеих полосах, чтобы выехать налево, с: дальше — выезжает направо. */
  outWait: 20,
  /** Надбавка ко времени пути с левым поворотом, с (ожидание просвета): при почти равных путях — направо. */
  penalty: 4,
  /** Другая машина пересекает встречку ближе стольких метров по оси — ждёт, пока та проедет. */
  apart: 30,
};

/**
 * Скорости манёвра, м/с игры (1 м/с — 2,2 км/ч): задним ходом во дворе и на полосу, передом с полосы в заезд (не
 * быстрее ~15 км/ч, а на дуге — √(LATERAL·R): lotMoves) и по двору; разгон и торможение — мягкие, без рывка.
 */
const SPEED = { yardBack: 2.5, roadBack: 3.5, roadOut: 7, turnIn: 7, yardIn: 3, accel: 3, brake: 4 };
/** Радиус поворотов по проездам открытой площадки, м игры (машина 7,5: в проезде 7 разворачивается в место). */
const YARD_TURN = 4.5;
/** Скорость по проездам открытой площадки, м/с игры: передом и задним ходом (путь — десятки метров, не заезд). */
const LOT_SPEED = { in: 4, back: 3.2 };
/** Место манёвра на полосе — не ближе стольких метров к её концам: там перекрёсток, стоп-линия, зебра. */
const END_ROOM = 10;
/**
 * Ждущая просвета у бордюра стоит хотя бы столько, с (смотрит по сторонам), и столько — встав на полосу задним ходом,
 * перед тем как тронуться вперёд. Подъехав к бордюру в просвет, не ждёт: смотрела, пока подъезжала.
 */
const LOOK = 0.8;
const PAUSE = 0.5;
/** Мягкое торможение, м/с² игры: подъезжая к заезду, позже этого уже не остановиться — проезжает мимо. */
const HOLD_BRAKE = 9;

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
  /** Дверь конкретного бокса; заезд с улицы остаётся общим для двора. */
  renderGate?: { pos: Vec; dir: Vec; width: number };
  hideBox?: Box;
  /** Общая зона манёвра соседних мест одного частного участка или гаражного двора. */
  groupKeys?: number[];
  /** Центр машины на месте (перед воротами, на площадке), в гараже и у бордюра (кузов в заезде, корма у полотна). */
  spot: Vec;
  inside: Vec;
  curbSide: Vec;
  /**
   * Ворот на деле нет — въезд на открытую площадку-стоянку (game/lotParking.ts): машина на манёвре видна всё время, без
   * тёмного проёма и не прячется за ним; путь по площадке до места — Homing.yard / leave(opt.via).
   */
  open?: boolean;
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
  /** Манёвр завершён или отменён: снять временные брони площадки. */
  finished?(): void;
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
  waitingForSpace?: boolean;
  waitForSpace?: boolean;
  /** Свернёт к месту налево, через встречку (Garages.leftSlotOf); нет — направо. */
  left?: boolean;
  /**
   * Открытая площадка: путь середины кузова от бордюра (curbSide) по проездам до места — спрашивается, когда машина
   * сворачивает к воротам (место выбирается тогда же); нет — до места за воротами по прямой.
   */
  yard?: () => Vec[] | null;
  /** Налево с ходу: встречка была свободна — её стоп-линия уже закрыта, машина повернёт, не останавливаясь. */
  block?: Block;
}

/** Стоп-линия встречки, пока машина её пересекает (LaneTraffic.turnStops): полотно и сама линия. */
type Block = { corridor: number; b: Barrier };

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
  /**
   * Левый поворот (полоса — крайняя левая встречного месту хода): полосы встречного потока, через которые машина
   * поворачивает к месту (и выезжает задним ходом), и что кузов на них заметает — [от, до] по ходу каждой. Нет —
   * поворот направо, с ближней к месту полосы.
   */
  cross?: { lane: GLane; zone: [number, number] }[];
  /** Левый поворот: стоп-линия встречного потока на время пересечения — полотно, место на оси и ход встречки. */
  stop?: { corridor: number; s: number; flow: 1 | -1 };
}

/** cross — въезд налево: стоит на своей полосе с поворотником и ждёт просвета во встречном потоке. */
type Phase = 'yard' | 'wait' | 'cross' | 'road' | 'pause' | 'home';

/** Машина на манёвре у гаража, площадки или места стоянки. */
interface Move {
  home: CarSpot;
  town: Town;
  color: string;
  hooks: MoveHooks;
  kind: 'out' | 'in';
  phase: Phase;
  /**
   * Отрезки манёвра и где машина на них: въезд — поворот с полосы и двор (тем же ходом, без остановки); выезд — двор
   * до бордюра и, если встала в поток с ходу, полоса за ним; ждала у бордюра — полоса отдельно, с места.
   */
  run: Run;
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
  /** Выезд к месту (стоянке магазина): путь к нему — направо или налево, что быстрее, решается на полосе. */
  to?: CarSpot;
  /** Выезд: налево ли (через ближнюю полосу в дальнюю) — решается у бордюра; и с какой полосы поехала. */
  left?: boolean;
  via?: GarageSlot;
  /** Въезд налево: как машина ехала к месту — не дождалась просвета, поедет так же, но к повороту направо. */
  homing?: Homing;
  /** Стоп-линия встречки, пока машина её пересекает (LaneTraffic.turnStops). */
  block?: Block;
  /** Выезд с места на открытой площадке: путь от бордюра до места (не дождалась просвета — по нему же обратно). */
  yard?: Leg;
  /** Выезд после разворота во дворе — к дороге носом наружу. */
  forward?: boolean;
  /** Тот же манёвр в обратном порядке, если на дороге так и не появилось просвета. */
  returnLegs?: Leg[];
  locks?: number[];
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
  /** Ограничение числа машин в потоке, если гараж управляет отдельным парком. */
  canJoin?(): boolean;
  /**
   * Машина со двора встала в поток: она — машина жителя (карточка: откуда куда), с этого мига — в счёте машин жителей
   * (до того, во дворе, — нет: в потоке её нет).
   */
  own(sim: Vehicle, trip: { from: TownBuilding; to: TownBuilding }): void;
  /** Машина жителя кончила поездку не у узла: сворачивая в гараж, ушла с полосы — снята с потока. */
  gone(sim: Vehicle): void;
}

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
  /** Устойчивая ссылка для выбора стоящей машины, независимо от здания под ней. */
  parkedCar?: string;
  hidden?: boolean;
  gate?: { pos: Vec; dir: Vec; width: number };
}

export { legPose };

/**
 * Где машина длиной L и шириной W встаёт на полосу и с неё сворачивает к заезду d (curbSide — середина кузова у
 * бордюра, кузов в заезде) — на графе g: крайняя правая полоса своего хода у бордюра со стороны заезда (на односторонней
 * с ним слева — нет), место поворота — на радиус поворота раньше заезда (mid), не ближе END_ROOM к концам полосы.
 * Нельзя (дорогу снесли, заезд у перекрёстка, полоса дальше 25 м, заезд не поперёк) — null. Общее для гаражей и
 * грузовиков у рамп (game/docks.ts).
 */
export function laneSlot(g: LaneGraph, net: LaneNet, d: Driveway, curbSide: Vec, L: number, W: number): GarageSlot | null {
  const at = drivewayLink(net, d);
  const c = at && net.corridors.get(at.corridor);
  if (!at || !c) return null;
  const { point, tangent } = c.lut.frameAt(at.s);
  const lat = dot(sub(d.curb, point), rightNormal(tangent));
  let best: { lane: GLane; link: GLink } | null = null;
  for (const link of g.corridorLinks(at.corridor)) {
    if (at.s < link.s0 || at.s > link.s1 || link.toNode === null) continue;
    const lane = link.lanes[link.lanes.length - 1];
    if (!lane || Math.sign(lane.offset) !== Math.sign(lat) || Math.abs(lane.offset) >= Math.abs(lat)) continue;
    if (!best || Math.abs(lane.offset) > Math.abs(best.lane.offset)) best = { lane, link };
  }
  if (!best) return null;
  const { lane, link } = best;
  const uc = link.flow > 0 ? at.s - link.s0 : link.s1 - at.s;
  const q = g.lanePose(lane, uc);
  // Заезд почти поперёк полосы — иначе поворот в него не по дуге.
  if (Math.abs(dot(d.dir, q.dir)) > 0.5) return null;
  const rel = sub(curbSide, q.pos);
  const lon = dot(rel, q.dir);
  const a = Math.abs(dot(rel, rightNormal(q.dir)));
  const mid = uc + lon - a;
  const zone: [number, number] = [mid - L / 2 - 0.5, uc + lon + W / 2 + 1];
  if (zone[0] < END_ROOM || zone[1] > lane.length - END_ROOM) return null;
  const p = g.lanePose(lane, mid);
  return { lane, link, mid, zone, pos: p.pos, f: p.dir };
}

export class Garages {
  /** Дом → его гараж или площадка (геометрия не меняется; null — места для машины нет). */
  private homes = new Map<number, GarageHome | null>();
  /** Дома с машиной в городе — для рисунка машин у ворот и счёта: по массиву домов города. */
  private towns = new Map<number, { of: TownBuilding[]; n: number; list: GarageHome[]; byId: Map<number, GarageHome>; box: [number, number, number, number] }>();
  /** Где машина встаёт на полосу — по ключу места, по нынешнему графу (сменился — заново, по мере надобности). */
  private slots = new Map<number, GarageSlot | null>();
  /** Где машина поворачивает к месту налево (и выезжает налево) — так же, по ключу места. */
  private lefts = new Map<number, GarageSlot | null>();
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
    return this.cachedSlot(home, false);
  }

  /**
   * Где машина поворачивает к месту налево, через встречку, и выезжает от него налево (LEFT_TURN): встречная дому
   * полоса улицы с движением в обе стороны, без разделителя, не шоссе, с пунктиром по оси на всём пути поворота
   * (centreLine); место поворота — на радиус поворота раньше заезда. Нельзя — null (только направо, slotOf).
   */
  leftSlotOf(home: CarSpot): GarageSlot | null {
    return this.cachedSlot(home, true);
  }

  /** Направо или налево — смотря куда машина едет. */
  private slotFor(home: CarSpot, left: boolean | undefined): GarageSlot | null {
    return left ? this.leftSlotOf(home) : this.slotOf(home);
  }

  private cachedSlot(home: CarSpot, left: boolean): GarageSlot | null {
    const g = this.host.graph;
    if (this.slotGraph !== g) {
      this.slots.clear();
      this.lefts.clear();
      this.slotGraph = g;
    }
    const cache = left ? this.lefts : this.slots;
    let s = cache.get(home.key);
    if (s !== undefined) return s;
    s = this.computeSlot(home, g, left);
    cache.set(home.key, s);
    return s;
  }

  private computeSlot(home: CarSpot, g: LaneGraph, left: boolean): GarageSlot | null {
    const net = this.host.net;
    const at = drivewayLink(net, home.d);
    const c = at && net.corridors.get(at.corridor);
    if (!at || !c) return null;
    const { point, tangent } = c.lut.frameAt(at.s);
    const lat = dot(sub(home.d.curb, point), rightNormal(tangent));
    // Ход со стороны дома (крайняя правая — у его бордюра) и встречный ему.
    let near: GLink | null = null;
    let far: GLink | null = null;
    const curbLane = (l: GLink) => l.lanes[l.lanes.length - 1];
    for (const link of g.corridorLinks(at.corridor)) {
      if (at.s < link.s0 || at.s > link.s1 || link.toNode === null) continue;
      const lane = curbLane(link);
      if (!lane) continue;
      if (Math.sign(lane.offset) === Math.sign(lat)) {
        if (Math.abs(lane.offset) < Math.abs(lat) && (!near || Math.abs(lane.offset) > Math.abs(curbLane(near).offset))) near = link;
      } else if (!far || Math.abs(lane.offset) < Math.abs(curbLane(far).offset)) far = link;
    }
    if (!near) return null;
    let link = near;
    let lane = curbLane(near);
    if (left) {
      if (!far || isTrunk(c.cls)) return null;
      lane = far.lanes[0];
      const inner = near.lanes[0];
      // Между ходами — разделитель (шире полосы): через него налево не поворачивают.
      if (Math.abs(lane.offset - inner.offset) > LANE_W + 0.5 || Math.sign(lane.offset) === Math.sign(inner.offset)) return null;
      link = far;
    }
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
    const slot: GarageSlot = { lane, link, mid, zone, pos: p.pos, f: p.dir };
    if (!left) return slot;
    // Осевая на всём пути поворота — от места, где машина начинает поворачивать, до заезда (с запасом в полкузова), —
    // пунктир; жёлтая (проспект) или белая сплошная (у перекрёстка) — налево нельзя. Та же осевая, что нарисована
    // (centreLine, обрезы у перекрёстков — как у разметки).
    const [ca, cb] = g.cutOf(c.id) ?? [0, 0];
    const sTurn = g.axisS(lane, mid);
    const from = Math.max(0, Math.min(sTurn, at.s) - L / 2);
    const to = Math.min(c.length, Math.max(sTurn, at.s) + L / 2);
    for (let s = from; s <= to + 1e-6; s += 1) if (centreLine(net, c, Math.min(s, to), ca, c.length - cb) !== 'dash') return null;
    // Что кузов заметает на встречных полосах, поворачивая к месту (выезжая — тем же путём задом): по точкам дуги —
    // те, что ближе полуширины полосы и полудиагонали кузова к оси полосы, ± полкузова вдоль неё.
    const turn = this.inLegs(home, p.pos, p.dir)[0];
    const reach = LANE_W / 2 + Math.hypot(L, W) / 2;
    const cross: { lane: GLane; zone: [number, number] }[] = [];
    let stop = near.flow > 0 ? Infinity : -Infinity;
    for (const l of near.lanes) {
      const ul = near.flow > 0 ? at.s - near.s0 : near.s1 - at.s;
      const o = g.lanePose(l, ul);
      let lo = Infinity;
      let hi = -Infinity;
      for (const pt of turn.pts) {
        const r = sub(pt, o.pos);
        if (Math.abs(dot(r, rightNormal(o.dir))) > reach) continue;
        const u = ul + dot(r, o.dir);
        lo = Math.min(lo, u);
        hi = Math.max(hi, u);
      }
      if (lo > hi) continue;
      const z: [number, number] = [lo - L / 2 - 0.5, hi + L / 2 + 0.5];
      // У самого перекрёстка (встречный выезжает из него на заезд) — нельзя.
      if (z[0] < 2 || z[1] > l.length - 2) return null;
      cross.push({ lane: l, zone: z });
      const s = g.axisS(l, z[0] - 1);
      stop = near.flow > 0 ? Math.min(stop, s) : Math.max(stop, s);
    }
    if (!cross.length) return null;
    return { ...slot, cross, stop: { corridor: c.id, s: stop, flow: near.flow } };
  }

  /**
   * Лучший путь к месту spot со связей starts (машина — в u на первой): к повороту направо или налево (через
   * встречку — с надбавкой LEFT_TURN.penalty), что быстрее; время — без уже пройденного по первой связи и без
   * остатка последней за местом. Не доехать — null.
   */
  wayFrom(starts: GLink[], spot: CarSpot, u = 0): { route: number[]; slot: GarageSlot; cost: number } | null {
    const g = this.host.graph;
    let best: { route: number[]; slot: GarageSlot; cost: number } | null = null;
    for (const slot of [this.slotOf(spot), this.leftSlotOf(spot)]) {
      if (!slot) continue;
      const route = findLaneRoute(g, starts, slot.link.toNode!, slot.link.id);
      if (!route) continue;
      // Место на той же связи, но позади машины, недостижимо прямым ходом: такой «короткий» путь нельзя
      // сравнивать с заездом с другой стороны (иначе машина выбирает неверный выезд и проезжает мимо места).
      if (route.length === 1 && slot.mid <= u) continue;
      const first = g.links.get(route[0])!;
      const cost = routeCost(g, route) - u / first.speed - (slot.lane.length - slot.mid) / slot.link.speed + (slot.cross ? LEFT_TURN.penalty : 0);
      if (!best || cost < best.cost) best = { route, slot, cost };
    }
    return best;
  }

  /** Путь к месту spot от узла from — направо или налево, что быстрее (wayFrom). Не доехать — null. */
  wayHome(from: number, spot: CarSpot): { route: number[]; slot: GarageSlot } | null {
    return this.wayFrom(this.host.graph.outLinks.get(from) ?? [], spot);
  }

  /** Геометрия места сменилась (магазин перестроили): где вставать на полосу — заново. */
  forgetSlot(key: number): void {
    this.slots.delete(key);
    this.lefts.delete(key);
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
    opt: { color?: string; hooks?: MoveHooks; endLink?: number; to?: CarSpot; then?: (sim: Vehicle) => void; via?: Vec[] | null; exit?: Leg[] | null | false; locks?: number[] } = {},
  ): void {
    const start = home.parks ? home.spot : home.inside;
    this.busy.add(home.key);
    const locks = [...new Set([...(home.groupKeys ?? []), ...(opt.locks ?? [])])];
    for (const key of locks) this.busy.add(key);
    // Открытая площадка: от места по проездам к воротам и через них к бордюру — задним ходом, тем же путём, каким
    // въезжают (via — от бордюра до места).
    const yard = opt.via && opt.via.length > 1 ? path([home.curbSide, ...opt.via], YARD_TURN, false, LOT_SPEED.in) : undefined;
    const exit = opt.exit === false ? null : opt.exit ?? (!yard ? homeExit(home, this.host.car.length, this.host.car.width) : null);
    const move: Move = {
      home,
      town,
      color: opt.color ?? home.color,
      hooks: opt.hooks ?? this.homeHooks(home, town),
      then: opt.then,
      kind: 'out',
      phase: 'yard',
      // К плану при выезде дописывается поворот на дорогу: массив текущего манёвра не должен менять кэш плана.
      run: runOf(exit ? [...exit] : [yard ? reversed(yard, true, LOT_SPEED.back) : straight(start, home.curbSide, true, SPEED.yardBack)]),
      forward: !!exit,
      returnLegs: exit?.slice().reverse().map((l) => reversed(l, !l.back, l.vmax)),
      yard,
      locks,
      wait: 0,
      target,
      endLink: opt.endLink,
      to: opt.to,
      trip,
    };
    this.moves.push(move);
  }

  /**
   * Маршрут к гаражу: от узла from, последней — связь у дома (Vehicle.endLink) — с поворотом к нему, как в slot (направо
   * или налево). Не доехать — null. Какой поворот ближе — wayHome.
   */
  routeHome(from: number, slot: GarageSlot): number[] | null {
    const g = this.host.graph;
    return findLaneRoute(g, g.outLinks.get(from) ?? [], slot.link.toNode!, slot.link.id);
  }

  /**
   * Машина в потоке sim везёт машину дома домой: маршрут уже к связи у дома (routeHome, wayHome) — slot, к повороту
   * направо или налево (slot.cross).
   */
  homeward(sim: Vehicle, home: CarSpot, town: Town, slot: GarageSlot): void {
    this.aim(sim, slot);
    this.homing.set(sim.id, { spot: home, town, hooks: this.homeHooks(home, town), reserved: true, left: !!slot.cross });
    this.busy.add(home.key);
    for (const key of home.groupKeys ?? []) this.busy.add(key);
  }

  /**
   * Машина в потоке sim едет на стоянку: маршрут — к связи у места planned (routeHome, wayHome; выехала со двора —
   * к той, что выбрана там, sim.endLink); какое место из свободных (choices) занять, решается на полосе у стоянки —
   * нет свободного, проезжает мимо (hooks.missed).
   */
  toStall(sim: Vehicle, planned: CarSpot, town: Town, slot: GarageSlot, hooks: MoveHooks, choices: () => CarSpot[], yard?: () => Vec[] | null, waitForSpace = false): void {
    const left = this.leftSlotOf(planned);
    const use = left && sim.endLink === left.link.id ? left : slot;
    this.aim(sim, use);
    this.homing.set(sim.id, { spot: planned, town, hooks, reserved: false, choices, left: !!use.cross, yard, waitForSpace });
  }

  /** Маршрут машины кончается связью у места: налево — держится левее (Vehicle.endLeft). */
  private aim(sim: Vehicle, slot: GarageSlot): void {
    sim.endLink = slot.link.id;
    if (slot.cross) sim.endLeft = true;
    else delete sim.endLeft;
  }

  /**
   * Едет ли машина к своему месту направо и уже встаёт (останавливается) напротив заезда — тогда прижимается к
   * бордюру (events.curbStop). Налево и с ходу — посреди своей полосы.
   */
  pulls(sim: Vehicle): boolean {
    // Сворачивает с ходу (slowTo) — по середине полосы: прижавшись, повернула бы круче.
    if (sim.holdDist === undefined || sim.holdV !== undefined) return false;
    const h = this.homing.get(sim.id);
    return !!h && !h.left;
  }

  /** Машина в потоке кончила поездку или потерялась (не у места): место её больше не ждёт. */
  forget(simId: number): void {
    const h = this.homing.get(simId);
    if (!h) return;
    this.homing.delete(simId);
    this.unblock(h);
    if (h.reserved) {
      this.busy.delete(h.spot.key);
      for (const key of h.spot.groupKeys ?? []) this.busy.delete(key);
    }
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

  /**
   * Подъезжающие к своему месту: к заезду — сбросить скорость до скорости поворота (налево при занятой встречке —
   * остановиться), доехали — повернуть в него.
   */
  private stepHoming(): void {
    const traffic = this.host.traffic;
    for (const [id, h] of [...this.homing]) {
      const sim = traffic.vehicles.get(id);
      if (!sim) {
        this.forget(id);
        continue;
      }
      const slot = this.slotFor(h.spot, h.left);
      // Дорогу поменяли — связи у места больше нет: едет просто к узлу (её endLink уже снят или не тот).
      if (!slot || sim.endLink !== slot.link.id) {
        this.cancelHoming(sim);
        continue;
      }
      if (h.waitingForSpace) {
        if (!h.choices?.().some((c) => !this.busy.has(c.key))) { sim.blinker = h.left ? -1 : 1; continue; }
        traffic.release(sim);
        delete h.waitingForSpace;
      }
      if (sim.holdDist === undefined) {
        const lane = sim.onMovement ? undefined : traffic.currentLane(sim);
        // Маршрут может вернуться на ту же улицу после объезда: первый проезд — ещё не подъезд к месту.
        if (!lane || lane.link !== slot.link.id || sim.routeIndex !== sim.route.length - 1) continue;
        // Поздно останавливаться — проехала мимо: поездка кончится у узла (налево — в объезд, к повороту направо).
        const late = (s: GarageSlot) => s.mid + sim.length / 2 - sim.s < (sim.v * sim.v) / (2 * HOLD_BRAKE) + 0.5;
        // Не в крайней полосе (широкая улица) — сначала перестроится к бордюру (на последней связи пути машина сама
        // держится правее; налево — левее), а остановка (holdAfter) запретила бы ей перестраиваться.
        if (lane.id !== slot.lane.id) {
          if (late(slot)) this.miss(sim, h);
          continue;
        }
        if (h.choices) {
          // Стоянка: ближнее из свободных мест, до которого ещё успеть остановиться; нет — мимо.
          let best: { spot: CarSpot; slot: GarageSlot } | null = null;
          for (const c of h.choices()) {
            const s = this.slotFor(c, h.left);
            if (!s || s.lane.id !== slot.lane.id || this.busy.has(c.key) || late(s)) continue;
            if (!best || s.mid < best.slot.mid) best = { spot: c, slot: s };
          }
          if (!best) {
            const wanted = h.choices();
            if (h.waitForSpace && wanted.length && wanted.every((c) => this.busy.has(c.key))) {
              h.waitingForSpace = true;
              traffic.holdAfter(sim, Math.max(0, slot.mid - sim.length / 2 - 2 - sim.s));
              sim.blinker = h.left ? -1 : 1;
              continue;
            }
            this.cancelHoming(sim);
            continue;
          }
          h.spot = best.spot;
          h.reserved = true;
          this.busy.add(best.spot.key);
          for (const key of best.spot.groupKeys ?? []) this.busy.add(key);
          this.approach(sim, best.spot, best.slot);
          continue;
        }
        if (late(slot)) this.miss(sim, h);
        else this.approach(sim, h.spot, slot);
        continue;
      }
      // Подъезжает к заезду — с поворотником к нему.
      const blink = dot(h.spot.d.dir, rightNormal(slot.f)) > 0 ? 1 : -1;
      sim.blinker = blink;
      // Налево: за тормозной путь до поворота смотрит на встречку — свободна: закрывает её и поворачивает с ходу;
      // занята — встаёт напротив заезда и ждёт просвета (stepCross).
      if (h.left && !h.block && sim.holdV !== undefined && sim.holdDist <= (sim.v * sim.v) / (2 * HOLD_BRAKE) + 1) {
        if (this.crossClear(slot)) h.block = this.block(slot, sim);
        else traffic.holdAfter(sim, sim.holdDist);
      }
      if (!traffic.held(sim)) continue;
      if (sim.lane !== slot.lane.id) {
        this.cancelHoming(sim);
        continue;
      }
      this.homing.delete(id);
      const c0 = sub(sim.pos, scale(sim.dir, sim.length / 2));
      const legs = this.inLegs(h.spot, c0, sim.dir);
      // Открытая площадка: от бордюра — по проездам до места, на виду (место выбирается сейчас).
      const via = h.yard?.();
      if (via && via.length > 1) legs[1] = path([h.spot.curbSide, ...via], YARD_TURN, false, LOT_SPEED.in);
      // С ходу — с той скоростью, с какой подъехала; встала (налево, встречка занята) — с места.
      const v0 = sim.holdV !== undefined ? sim.v : 0;
      traffic.holdAfter(sim, 0);
      sim.lcCooldown = 1e9;
      const block = h.block;
      h.block = undefined;
      this.moves.push({
        home: h.spot,
        town: h.town,
        color: sim.color,
        hooks: h.hooks,
        kind: 'in',
        phase: h.left && !block ? 'cross' : 'road',
        run: runOf(legs, v0),
        sim,
        wait: 0,
        blink,
        homing: h,
        locks: h.spot.groupKeys,
        block,
      });
    }
  }

  /** К повороту к месту spot (slot): сбросить скорость до той, с какой машина пройдёт поворот в заезд с ходу. */
  private approach(sim: Vehicle, spot: CarSpot, slot: GarageSlot): void {
    const vt = entrySpeed(this.inLegs(spot, slot.pos, slot.f), SPEED.brake);
    this.host.traffic.slowTo(sim, slot.mid + sim.length / 2 - sim.s, vt);
  }

  /** Не успела свернуть к месту: налево — в объезд, к повороту направо; направо — поездка кончится у узла. */
  private miss(sim: Vehicle, h: Homing): void {
    if (h.left) this.toRight(sim, h);
    else this.cancelHoming(sim);
  }

  /**
   * Налево не вышло (не дождалась просвета, не успела в левую полосу или остановиться): в объезд — к повороту направо,
   * как без левого. Не доехать — поездка кончится у узла.
   */
  private toRight(sim: Vehicle, h: Homing): void {
    const traffic = this.host.traffic;
    const g = this.host.graph;
    if (sim.holdDist !== undefined) traffic.release(sim);
    delete sim.endLeft;
    this.homing.delete(sim.id);
    this.unblock(h);
    // Стоянка: место, к которому сворачивала, освобождается — у стоянки выберет заново.
    const next: Homing = { ...h, left: false };
    if (h.choices && h.reserved) {
      this.busy.delete(h.spot.key);
      for (const key of h.spot.groupKeys ?? []) this.busy.delete(key);
      next.reserved = false;
    }
    const right = this.slotOf(h.spot);
    const lane = sim.onMovement ? undefined : traffic.currentLane(sim);
    const link = lane && g.links.get(lane.link);
    const route = right && link && findLaneRoute(g, [link], right.link.toNode!, right.link.id);
    if (!right || !route) {
      delete sim.endLink;
      if (next.reserved) {
        this.busy.delete(h.spot.key);
        for (const key of h.spot.groupKeys ?? []) this.busy.delete(key);
      }
      h.hooks.missed?.();
      return;
    }
    sim.endLink = right.link.id;
    traffic.redirect(sim, right.link.toNode!, route);
    this.homing.set(sim.id, next);
  }

  /** Встречные полосы свободны для левого поворота: всем подъезжающим хватит места остановиться, никто не пересекает рядом. */
  private crossClear(slot: GarageSlot): boolean {
    const traffic = this.host.traffic;
    const stop = slot.stop!;
    for (const b of traffic.turnStops.get(stop.corridor) ?? []) if (Math.abs(b.s - stop.s) < LEFT_TURN.apart) return false;
    return slot.cross!.every((x) => traffic.clearToJoin(x.lane.id, x.zone[0], x.zone[1]));
  }

  /** Пересекает встречку (или вот-вот пересечёт с ходу): стоп-линия встречного потока перед местом, пока кузов над ним. */
  private block(slot: GarageSlot, sim: Vehicle): Block {
    const stop = slot.stop!;
    const b: Barrier = { s: stop.s, closed: true, busy: false, flow: stop.flow, stop: 0, vehicle: sim.id };
    const map = this.host.traffic.turnStops;
    const list = map.get(stop.corridor);
    if (list) list.push(b);
    else map.set(stop.corridor, [b]);
    return { corridor: stop.corridor, b };
  }

  /** Встречка снова открыта: стоп-линию манёвра или подъезжающей с ходу (x.block) — снять. */
  private unblock(x: { block?: Block }): void {
    const block = x.block;
    if (!block) return;
    const map = this.host.traffic.turnStops;
    const list = map.get(block.corridor)?.filter((b) => b !== block.b);
    if (list?.length) map.set(block.corridor, list);
    else map.delete(block.corridor);
    x.block = undefined;
  }

  /** Стоп-линий встречки, закрытых машинами у мест (на манёвре и подъезжающими налево с ходу), — для проверок. */
  get blocks(): number {
    let n = 0;
    for (const m of this.moves) if (m.block) n++;
    for (const h of this.homing.values()) if (h.block) n++;
    return n;
  }

  /**
   * Въезд налево: стоит на своей полосе с левым поворотником, пока во встречном потоке нет просвета (crossClear), —
   * дождалась: закрывает встречку и поворачивает; ждёт дольше LEFT_TURN.maxWait — едет в объезд (toRight).
   */
  private stepCross(m: Move, dt: number): boolean {
    const traffic = this.host.traffic;
    const sim = m.sim!;
    m.wait += dt;
    sim.blinker = m.blink ?? 0;
    const slot = this.leftSlotOf(m.home);
    if (!slot || sim.onMovement || sim.lane !== slot.lane.id) {
      // Дорогу поменяли — поездка кончится у узла.
      traffic.release(sim);
      delete sim.endLink;
      delete sim.endLeft;
      sim.lcCooldown = 0.5;
      m.hooks.missed?.();
      return this.done(m);
    }
    if (m.wait > LEFT_TURN.maxWait) {
      sim.lcCooldown = 0.5;
      this.toRight(sim, m.homing!);
      return false;
    }
    if (m.wait < LOOK || !this.crossClear(slot)) return true;
    m.block = this.block(slot, sim);
    m.phase = 'road';
    m.wait = 0;
    this.pose(m);
    return true;
  }

  /** Въезд с полосы: поворот от центра кузова c0 (курс f) к бордюру и по заезду до места или в гараж. */
  private inLegs(home: CarSpot, c0: Vec, f: Vec): [Leg, Leg] {
    const end = home.curbSide;
    const k = 0.55 * Math.max(2, Math.abs(dot(sub(end, c0), rightNormal(f))));
    return [
      bezier(c0, add(c0, scale(f, k)), sub(end, scale(home.d.dir, k)), end, false, SPEED.turnIn),
      straight(end, home.parks ? home.spot : home.inside, false, SPEED.yardIn),
    ];
  }

  /** Едет к месту, но к нему не свернёт (дорогу поменяли, проехала мимо): поездка кончается у узла, как у всех. */
  private cancelHoming(sim: Vehicle): void {
    delete sim.endLink;
    delete sim.endLeft;
    if (sim.holdDist !== undefined) this.host.traffic.release(sim);
    this.forget(sim.id);
  }

  /** Шаг манёвра; false — кончился. */
  private stepMove(m: Move, dt: number): boolean {
    const traffic = this.host.traffic;
    // Машину в потоке сняли (потерялась при правке сети) — и манёвра больше нет.
    if (m.sim && !traffic.vehicles.has(m.sim.id)) return this.done(m);
    if (m.phase === 'wait') return this.stepWait(m, dt);
    if (m.phase === 'cross') return this.stepCross(m, dt);
    if (m.phase === 'pause') {
      m.wait += dt;
      this.pose(m);
      if (m.wait < PAUSE) return true;
      // Встала на полосу носом по ходу — поехала.
      const sim = m.sim!;
      handOff(traffic, sim);
      m.then?.(sim);
      return this.done(m);
    }
    // На участке поворотник не нужен; включает его только при подъезде к выезду на дорогу.
    if (m.kind === 'out' && m.phase === 'yard' && !m.sim) {
      if (m.run.i === m.run.legs.length - 1 && m.run.legs[m.run.i].len - m.run.s < 8) {
        const slot = this.exitSlot(m);
        if (slot) m.blink = this.exitBlink(m, slot);
      } else m.blink = undefined;
    }
    // У бордюра смотрит, есть ли просвет: есть — встаёт в поток с ходу.
    if (m.kind === 'out' && m.phase === 'yard' && !m.sim && m.run.i === m.run.legs.length - 1 && decideNow(m.run, SPEED.brake)) {
      const slot = this.exitSlot(m);
      if (slot) m.blink = this.exitBlink(m, slot);
      if (slot && this.joinClear(slot)) this.join(m, slot, true);
    }
    if (advance(m.run, dt, SPEED, m.forward && m.sim ? SPEED.roadOut : 0, () => this.passed(m)) && !this.runDone(m)) return this.done(m);
    this.pose(m);
    return true;
  }

  /** Машина ушла с отрезка на следующий тем же ходом: въезд — кузов ушёл с полосы в заезд; выезд с ходу — на полосу. */
  private passed(m: Move): void {
    if (m.kind === 'out') {
      if (m.sim) m.phase = 'road';
      return;
    }
    if (m.phase !== 'road' || !m.sim) return;
    // Кузов ушёл с полосы в заезд — поездка в потоке кончилась; встречка снова открыта.
    const sim = m.sim;
    this.unblock(m);
    leaveFlow(this.host.traffic, sim);
    this.host.gone(sim);
    m.sim = undefined;
    m.phase = 'yard';
  }

  /** Отрезки манёвра пройдены — следующая фаза; false — манёвр кончился. */
  private runDone(m: Move): boolean {
    if (m.kind === 'out' && m.phase === 'yard') {
      // У бордюра просвета не было — ждёт его.
      m.phase = 'wait';
      m.wait = 0;
      m.run.v = 0;
      return true;
    }
    if (m.kind === 'out' && m.phase === 'road') {
      if (m.forward) {
        this.unblock(m);
        handOff(this.host.traffic, m.sim!, m.run.v);
        m.then?.(m.sim!);
        return false;
      }
      // Встала на полосу задним ходом (выезд налево — на дальнюю: встречка снова открыта) — переключает ход.
      this.unblock(m);
      m.phase = 'pause';
      m.wait = 0;
      m.run.v = 0;
      return true;
    }
    // Доехала до места (въезд) или передумала и вернулась (выезд): машина на месте.
    if (m.kind === 'in') m.hooks.arrived?.(m.home);
    else m.hooks.stayed?.();
    return false;
  }

  /**
   * С какой полосы выезжать: налево (задним ходом через ближнюю полосу в дальнюю) — если так быстрее (решается раз,
   * у бордюра или подъезжая к нему) и ждёт не дольше LEFT_TURN.outWait; иначе — направо. Негде — null.
   */
  private exitSlot(m: Move): GarageSlot | null {
    const right = this.outSlot(m.home, false, !!m.forward);
    // Задним ходом — только на ближайшую полосу. Через встречку можно повернуть лишь передом.
    if (!m.forward) return right;
    m.left ??= this.exitLeft(m, right);
    return (m.left && m.wait <= LEFT_TURN.outWait ? this.outSlot(m.home, true, true) : null) ?? right;
  }

  /** Передом встаёт на полосу после выезда, зеркально месту начала въезда с неё. */
  private outSlot(home: CarSpot, left: boolean, forward: boolean): GarageSlot | null {
    const slot = left ? this.leftSlotOf(home) : this.slotOf(home);
    if (!slot || !forward) return slot;
    const along = dot(sub(home.curbSide, slot.pos), slot.f);
    const lateral = Math.abs(dot(sub(home.curbSide, slot.pos), rightNormal(slot.f)));
    const mid = slot.mid + along + lateral;
    const L = this.host.car.length;
    const zone: [number, number] = [slot.mid + along - this.host.car.width / 2 - 1, mid + L / 2 + 0.5];
    if (zone[0] < END_ROOM || zone[1] > slot.lane.length - END_ROOM) return null;
    const g = this.host.graph;
    const p = g.lanePose(slot.lane, mid);
    const out: GarageSlot = { ...slot, mid, zone, pos: p.pos, f: p.dir };
    if (slot.cross) {
      const at = drivewayLink(this.host.net, home.d)!;
      out.cross = slot.cross.map((c) => {
        const link = g.links.get(c.lane.link)!;
        const u = link.flow > 0 ? at.s - link.s0 : link.s1 - at.s;
        return { lane: c.lane, zone: [2 * u - c.zone[1], 2 * u - c.zone[0]] };
      });
      if (out.cross.some((c) => c.zone[0] < 2 || c.zone[1] > c.lane.length - 2)) return null;
      const stops = out.cross.map((c) => g.axisS(c.lane, c.zone[0] - 1));
      out.stop = { ...slot.stop!, s: slot.stop!.flow > 0 ? Math.min(...stops) : Math.max(...stops) };
    }
    return out;
  }

  /** Просвет для выезда на полосу slot: на ней, а налево — и во встречке. */
  private joinClear(slot: GarageSlot): boolean {
    return this.host.canJoin?.() !== false && this.host.traffic.clearToJoin(slot.lane.id, slot.zone[0], slot.zone[1]) && (!slot.cross || this.crossClear(slot));
  }

  /** Ждёт у бордюра просвета; дождалась — встаёт в поток (стоит, пока выезжает); не дождалась — обратно на место. */
  private stepWait(m: Move, dt: number): boolean {
    m.wait += dt;
    const slot = this.exitSlot(m);
    if (slot) m.blink = this.exitBlink(m, slot);
    const giveUp = !slot || m.wait > GARAGE_TRIPS.maxWait;
    if (!giveUp && (m.wait < LOOK || !this.joinClear(slot))) return true;
    if (giveUp || !this.join(m, slot, false)) {
      // Не дождалась (или ехать некуда) — обратно на место: с открытой площадки — по проездам, каким выехала.
      m.phase = 'home';
      m.run = runOf(m.returnLegs ?? [m.yard ?? straight(m.home.curbSide, m.home.parks ? m.home.spot : m.home.inside, false, SPEED.yardIn)]);
    }
    return true;
  }

  /**
   * Встаёт в поток на полосу slot: машина в потоке (стоит, пока выезжает) и задним ходом — от бордюра на полосу.
   * rolling — ещё подъезжает к бордюру: путь на полосу продолжает её ход, без остановки. Не встать — false.
   */
  private join(m: Move, slot: GarageSlot, rolling: boolean): boolean {
    // Едет к месту (стоянке магазина) — к повороту направо или налево, что быстрее отсюда.
    const way = m.to ? this.wayFrom([slot.link], m.to, slot.mid) : null;
    if (way) {
      m.target = way.slot.link.toNode!;
      m.endLink = way.slot.link.id;
    }
    const L = this.host.car.length;
    const sim = joinLane(this.host.traffic, { ...this.host.car, color: m.color }, slot.lane.id, slot.mid + L / 2, m.target!, m.endLink);
    if (!sim) return false;
    this.host.own(sim, m.trip!);
    m.hooks.joined?.(sim);
    const start = m.home.curbSide;
    const k = 0.55 * Math.max(2, Math.abs(dot(sub(start, slot.pos), rightNormal(slot.f))));
    m.sim = sim;
    m.via = slot;
    // Передний поворот налево: встречка закрыта, пока кузов над ней.
    if (slot.cross) m.block = this.block(slot, sim);
    const leg = m.forward
      ? bezier(start, sub(start, scale(m.home.d.dir, k)), sub(slot.pos, scale(slot.f, k)), slot.pos, false, SPEED.roadOut)
      : bezier(start, sub(start, scale(m.home.d.dir, k)), add(slot.pos, scale(slot.f, k)), slot.pos, true, SPEED.roadBack);
    m.blink = this.exitBlink(m, slot);
    if (rolling) m.run.legs.push(leg);
    else {
      m.phase = 'road';
      m.run = runOf([leg]);
    }
    this.pose(m);
    return true;
  }

  /**
   * Выезжать ли налево: можно (leftSlotOf) и путь с дальней полосы к цели (узлу или месту) хотя бы на
   * LEFT_TURN.penalty быстрее, чем с ближней.
   */
  private exitLeft(m: Move, right: GarageSlot | null): boolean {
    const left = this.outSlot(m.home, true, !!m.forward);
    if (!left || !right) return false;
    const g = this.host.graph;
    const cost = (s: GarageSlot): number => {
      if (m.to) return this.wayFrom([s.link], m.to, s.mid)?.cost ?? Infinity;
      const route = findLaneRoute(g, [s.link], m.target!, m.endLink);
      return route ? routeCost(g, route) - s.mid / s.link.speed : Infinity;
    };
    return cost(left) + LEFT_TURN.penalty < cost(right);
  }

  private done(m: Move): false {
    this.unblock(m);
    this.busy.delete(m.home.key);
    for (const key of m.locks ?? []) this.busy.delete(key);
    m.hooks.finished?.();
    return false;
  }

  private exitBlink(m: Move, slot: GarageSlot): -1 | 1 {
    const outward = scale(m.home.d.dir, -1);
    const forwardTurn = dot(slot.f, rightNormal(outward)) > 0 ? 1 : -1;
    // При заднем ходе колёса и огни показывают поворот кузова, который смотрит внутрь участка.
    return m.forward ? forwardTurn : forwardTurn === 1 ? -1 : 1;
  }

  /** Машина в потоке на манёвре — там, где она на нём (поток её держит на месте: holdAfter). */
  private pose(m: Move): void {
    if (m.sim) poseSim(m.sim, m.run, m.blink ?? 0);
  }

  /**
   * Машина места key (у дома — id дома) на манёвре: нос, курс, скорость на манёвре, фаза и машина в потоке (пока кузов
   * над полосой). Нет манёвра — null.
   */
  moveOf(key: number): { pos: Vec; dir: Vec; v: number; phase: Phase; kind: 'out' | 'in'; sim?: Vehicle } | null {
    const m = this.moves.find((x) => x.home.key === key);
    if (!m) return null;
    const v = m.phase === 'wait' || m.phase === 'cross' || m.phase === 'pause' ? 0 : m.run.v;
    if (m.sim) return { pos: m.sim.pos, dir: m.sim.dir, v, phase: m.phase, kind: m.kind, sim: m.sim };
    const { c, h } = runPose(m.run);
    return { pos: add(c, scale(h, this.host.car.length / 2)), dir: h, v, phase: m.phase, kind: m.kind };
  }

  /** Едет ли машина в потоке к своему месту (и какому: у дома — id дома). */
  homingOf(simId: number): number | undefined {
    return this.homing.get(simId)?.spot.key;
  }

  /** Видимый манёвр выбранной машины и тот, кого она ждёт перед левым поворотом. */
  activity(sim: Vehicle): TrafficActivity | undefined {
    const move = this.moves.find((m) => m.sim === sim);
    if (move?.phase === 'cross') {
      const slot = this.leftSlotOf(move.home);
      for (const cross of slot?.cross ?? []) {
        const other = this.host.traffic.joinBlocker(cross.lane.id, ...cross.zone);
        if (other) return { kind: 'yield', vehicle: other.id };
      }
      return { kind: 'yield' };
    }
    if (move) return { kind: 'parking' };
    if (this.homing.get(sim.id)?.waitingForSpace) return { kind: 'parking-space' };
    return;
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
      if (m.kind === 'in') {
        const { legs, i, s } = m.run;
        return { only: true, tail: [sim.pos, ...nose(legs[i], s), ...legs.slice(i + 1).flatMap((l) => nose(l, 0))] };
      }
      const slot = m.via ?? this.slotOf(m.home);
      if (!slot) return null;
      const anchor = add(slot.pos, scale(slot.f, L / 2));
      return { head: [sim.pos, anchor], anchor };
    }
    const h = this.homing.get(simId);
    const slot = h && this.slotFor(h.spot, h.left);
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
      if (m.sim) continue;
      const { c, h } = runPose(m.run);
      if (!inBox(c, 10)) continue;
      const look: VehicleLook = { ...spec, color: m.color, pos: add(c, scale(h, spec.length / 2)), dir: h, blinker: m.blink ?? 0 };
      // Проём ворот и машина за ним спрятана — только у настоящих ворот (гараж, арка, боксы), у открытой площадки — нет.
      const outsideBox = m.home.hideBox && !boxesOverlap(m.home.hideBox, { c, d: h, hl: spec.length / 2, hw: spec.width / 2 });
      out.push(m.home.parks || m.home.open || outsideBox ? { look } : { look, gate: m.home.renderGate ?? { pos: m.home.d.gate, dir: m.home.d.dir, width: m.home.d.width } });
    }
    return out;
  }
}

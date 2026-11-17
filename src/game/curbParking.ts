import { add, dist, scale, sub, type Vec } from '../core/vec';
import { boxesOverlap, CURB, curbDrive, curbStalls, stallBox, stallTee, type CurbStall } from '../lanes/curb';
import type { GLane, GLink, LaneGraph } from '../lanes/graph';
import type { LaneNet } from '../lanes/model';
import { findLaneRoute, routeCost } from '../lanes/routing';
import type { LaneTraffic } from '../lanes/traffic';
import { steerBase } from '../sim/body';
import type { Vehicle, VehicleLook, VehicleSpec } from '../sim/vehicle';
import type { TownBuilding } from '../world/entities';
import type { GarageLook } from './garages';
import { bezier, legPose, type Leg } from './lotMoves';

/**
 * Машины на полосах стоянки вдоль бордюра (docs/PARKING.md, этап 2; места — lanes/curb.ts). Места — и места ночёвки
 * (CarHomes: свой гараж или площадка → двор → полоса в CURB_TRIPS.homeRange → бокс), и места у цели поездки: машина
 * едет к связи у цели и на полосе у мест выбирает ближнее свободное — как на стоянке магазина.
 *
 * Манёвры (lotMoves.ts): впереди два свободных места — встаёт передом (S-образно, в потоке ~2 с); иначе проезжает место и
 * встаёт параллельно задом (~6 с) — всё это время держит полосу (holdAfter). Выезд — передом, когда на полосе настоящий
 * просвет (LaneTraffic.clearToJoin). На одной полосе стоянки одновременно — не больше одного манёвра на CURB_TRIPS.apart.
 * Пока кузов над полосой движения, машина — в потоке (стоит, её ждут и объезжают); у места — только рисунок.
 *
 * Кто где стоит — данные: места ночёвки — у CarHomes (по геометрии), машины у цели — Town.cars (TownCar.curb, ключ
 * места: полотно, сторона, номер); тут — только кто занял (park), кто едет к месту (homing) и манёвры, без генератора
 * случайных чисел партии.
 *
 * Место занято (occupied): стоит гость, стоит дома хозяин места ночёвки или место забронировано. Бронь у места одна и
 * у одного владельца (подъезжающая машина, потом её манёвр; выезжающая машина) — снимает её только он: въезд — встав на
 * место, выезд — когда кузов вышел из габарита места (stallBox), а не когда машина тронулась. Выбирая место, машина
 * смотрит на occupied — занятое пропускает и ищет дальше, как обычно.
 */
export const CURB_TRIPS = {
  /** Место ночёвки на полосе — не дальше стольких ед. от дома (≈ 150 м). */
  homeRange: 250,
  /** Место у цели — на полосах не дальше стольких ед. от неё (≈ 90 м): её улица и соседние. */
  destRange: 150,
  /** Место у цели: из скольких ближних связей с местами выбирать по времени пути и сколько с стоит ед. пешком. */
  tryLinks: 4,
  walk: 0.1,
  /** Места ночёвки берут не больше этой доли мест полосы: остальные — гостям. */
  homeShare: 0.5,
  /** Сколько машина ждёт просвета, чтобы выехать, с: не дождалась — осталась на месте. */
  maxWait: 40,
  /** Два манёвра на одной полосе стоянки — не ближе стольких ед. по оси. */
  apart: 30,
  /** Передом: S-образный въезд начинается на столько ед. раньше середины места (через свободное место перед ним). */
  fwdRun: 13,
  /** Задом: машина встаёт серединой на столько ед. дальше места (у соседнего впереди) и сдаёт назад. */
  revRun: 10.5,
  /** Выезд: середина машины встаёт на полосу на столько ед. дальше места. */
  exitRun: 12,
};

/** Скорости манёвра, ед./с игры: передом с полосы на место, задом на место, передом с места; разгон и торможение. */
const SPEED = { fwdIn: 4, revIn: 2.2, out: 3.5, accel: 3, brake: 4 };
/** Перед выездом машина стоит хотя бы столько (смотрит по сторонам), с; и столько — встав на полосу. */
const LOOK = 0.8;
const PAUSE = 0.5;
/** Мягкое торможение: подъезжая к месту, позже этого не остановиться — проезжает мимо. */
const HOLD_BRAKE = 9;
/** Передом машина сворачивает с ходу: тормозит к точке на столько ед. дальше начала манёвра и сворачивает раньше. */
const FWD_ROLL = 5;

/** Что делать, когда манёвр дошёл до вехи: встала в поток (выезд), встала на место, не выехала, не нашла места. */
export interface CurbHooks {
  joined?(sim: Vehicle): void;
  arrived?(stall: CurbStall): void;
  stayed?(): void;
  missed?(): void;
}

/** Что игра даёт полосам стоянки. */
export interface CurbHost {
  readonly traffic: LaneTraffic;
  readonly graph: LaneGraph;
  readonly net: LaneNet;
  readonly car: Omit<VehicleSpec, 'color'>;
  /** Машина встала в поток с места (как GarageHost.own) и свернула на место (как GarageHost.gone). */
  own(sim: Vehicle, trip: { from: TownBuilding; to: TownBuilding }): void;
  gone(sim: Vehicle): void;
  /**
   * Где на полосах стоянки мест нет — заезды во дворы и гаражи, остановки: по `${полотно}:${сторона}` — отрезки оси; и
   * подпись (сменилась — места заново).
   */
  curbSkips(): { sig: string; skips: Map<string, [number, number][]> };
  /** Светофор в узле. */
  lights(node: number): boolean;
}

/** Где машина у места на нынешнем графе: связь и полоса движения рядом с ним, u середины места по полосе. */
interface CurbSlot {
  link: GLink;
  lane: GLane;
  u: number;
}

/** Раскладка мест по нынешней сети. */
interface Layout {
  graph: LaneGraph;
  sig: string;
  all: CurbStall[];
  byKey: Map<string, CurbStall>;
  /** Сетка поиска: ячейка → места. */
  grid: Map<number, CurbStall[]>;
  /** Места полосы стоянки по порядку оси: `${полотно}:${полоса}`. */
  byLane: Map<string, CurbStall[]>;
  slots: Map<string, CurbSlot | null>;
}

const CELL = 120;
const cellKey = (x: number, y: number) => x * 100003 + y;
const laneKey = (st: CurbStall) => `${st.corridor}:${st.lane}`;

/** Едет к месту на полосе стоянки: по какой связи, из каких мест выбирать, какое выбрано и как встанет. */
interface Homing {
  link: number;
  choices: () => CurbStall[];
  hooks: CurbHooks;
  stall?: CurbStall;
  mode?: 'fwd' | 'rev';
  /** Где на полосе нос машины в начале манёвра. */
  nose?: number;
  color: string;
  /** Машина парка (ключ), если это она: её бронь — не помеха ей самой (места ночёвки, CarHomes). */
  car?: number;
}

type Phase = 'wait' | 'road' | 'yard' | 'pause';

interface Move {
  stall: CurbStall;
  kind: 'in' | 'out';
  phase: Phase;
  leg: Leg | null;
  s: number;
  v: number;
  wait: number;
  color: string;
  hooks: CurbHooks;
  sim?: Vehicle;
  /** Въезд передом: машина уходит из потока, когда пройдено столько пути манёвра (кузов над стоянкой). */
  dropAt?: number;
  /** Выезд: куда, последняя связь пути, что делать в потоке, откуда куда (карточка). */
  target?: number;
  endLink?: number;
  then?: (sim: Vehicle) => void;
  trip?: { from: TownBuilding; to: TownBuilding };
  car?: number;
}

/** Чья бронь у места: подъезжающей машины или манёвра. */
type Holder = Homing | Move;

export class CurbParking {
  private layout: Layout | null = null;
  /** Растёт, когда меняются места (сеть, заезды): парк машин назначает места ночёвки заново. */
  version = 0;
  /** Места ночёвки машин парка (их гостям не занять): по городу. */
  private assigned = new Map<number, Set<string>>();
  private assignedAll = new Set<string>();
  /** Машины у цели на местах: место → ключ машины парка. */
  private parked = new Map<string, number>();
  /** Бронь: места, к которым едут, на которых манёвр или с которых выезжают (пока кузов в габарите места), — чья. */
  private reserved = new Map<string, Holder>();
  readonly moves: Move[] = [];
  private homing = new Map<number, Homing>();

  constructor(private host: CurbHost) {}

  // ---------- Места ----------

  /** Места по нынешней сети (сменился граф или заезды — заново). */
  private lay(): Layout {
    const g = this.host.graph;
    const skips = this.host.curbSkips();
    const hit = this.layout;
    if (hit && hit.graph === g && hit.sig === skips.sig) return hit;
    const net = this.host.net;
    const all: CurbStall[] = [];
    for (const c of net.corridors.values()) {
      if (c.build || !c.lanes.some((l) => l.park)) continue;
      const cut = g.cutOf(c.id) ?? [0, 0];
      const lights: [boolean, boolean] = [this.host.lights(c.a), this.host.lights(c.b)];
      c.lanes.forEach((l, i) => {
        if (!l.park) return;
        const side = l.offset > 0 ? 1 : -1;
        all.push(...curbStalls(net, c, i, cut, lights, skips.skips.get(`${c.id}:${side}`) ?? []));
      });
    }
    const grid = new Map<number, CurbStall[]>();
    const byLane = new Map<string, CurbStall[]>();
    for (const st of all) {
      const k = cellKey(Math.floor(st.pos.x / CELL), Math.floor(st.pos.y / CELL));
      const list = grid.get(k);
      if (list) list.push(st);
      else grid.set(k, [st]);
      const lk = laneKey(st);
      const ll = byLane.get(lk);
      if (ll) ll.push(st);
      else byLane.set(lk, [st]);
    }
    const keys = (x: Layout | null) => (x ? x.all.map((s) => s.key).join() : '');
    const next: Layout = { graph: g, sig: skips.sig, all, byKey: new Map(all.map((s) => [s.key, s])), grid, byLane, slots: new Map() };
    if (keys(hit) !== keys(next)) this.version++;
    this.layout = next;
    return next;
  }

  /** Все места. */
  stalls(): readonly CurbStall[] {
    return this.lay().all;
  }

  stall(key: string): CurbStall | undefined {
    return this.lay().byKey.get(key);
  }

  /** Места не дальше r от точки. */
  near(p: Vec, r: number): CurbStall[] {
    const L = this.lay();
    const out: CurbStall[] = [];
    for (let x = Math.floor((p.x - r) / CELL); x <= Math.floor((p.x + r) / CELL); x++) {
      for (let y = Math.floor((p.y - r) / CELL); y <= Math.floor((p.y + r) / CELL); y++) {
        for (const st of L.grid.get(cellKey(x, y)) ?? []) if (dist(st.pos, p) <= r) out.push(st);
      }
    }
    return out;
  }

  /** Место по ключу, а нет его (сеть поправили) — то, что у pos не дальше tol (машина ищет своё по положению). */
  find(key: string | undefined, pos: Vec | undefined, tol = 3): CurbStall | null {
    const st = key ? this.stall(key) : undefined;
    if (st && (!pos || dist(st.pos, pos) <= tol)) return st;
    if (!pos) return null;
    let best: CurbStall | null = null;
    for (const x of this.near(pos, tol)) if (!best || dist(x.pos, pos) < dist(best.pos, pos)) best = x;
    return best;
  }

  /** Места полосы стоянки, где место st, по порядку оси. */
  private laneStalls(st: CurbStall): CurbStall[] {
    return this.lay().byLane.get(laneKey(st)) ?? [];
  }

  /** Связь и полоса движения у места, u его середины по ней — на нынешнем графе; нельзя подъехать — null. */
  slotOf(st: CurbStall): CurbSlot | null {
    const L = this.lay();
    const hit = L.slots.get(st.key);
    if (hit !== undefined) return hit;
    const g = this.host.graph;
    const c = this.host.net.corridors.get(st.corridor);
    const P = c?.lanes[st.lane];
    const D = c && P ? curbDrive(c, P) : null;
    const di = c && D ? c.lanes.indexOf(D) : -1;
    let res: CurbSlot | null = null;
    if (c && P && di >= 0) {
      for (const link of g.corridorLinks(c.id)) {
        if (link.flow !== P.flow || st.s < link.s0 || st.s > link.s1 || link.toNode === null) continue;
        const lane = link.lanes.find((l) => l.laneIdx === di);
        // Полоса у стоянки — крайняя справа на связи (правее — только стоянка).
        if (!lane || lane !== link.lanes[link.lanes.length - 1]) continue;
        res = { link, lane, u: link.flow > 0 ? st.s - link.s0 : link.s1 - st.s };
        break;
      }
    }
    L.slots.set(st.key, res);
    return res;
  }

  // ---------- Кто занял ----------

  /** Места ночёвки машин парка города (CarHomes.build): гостям их не занять. */
  setAssigned(town: number, keys: Set<string>): void {
    this.assigned.set(town, keys);
    this.assignedAll = new Set([...this.assigned.values()].flatMap((s) => [...s]));
  }

  /** Место — место ночёвки машины другого города (не town). */
  assignedElsewhere(key: string, town: number): boolean {
    if (!this.assignedAll.has(key)) return false;
    return !this.assigned.get(town)?.has(key);
  }

  /** Машина парка car стоит на месте key у цели (Town.cars, TownCar.curb). */
  park(key: string, car: number): void {
    this.parked.set(key, car);
  }

  unpark(key: string, car?: number): void {
    if (car === undefined || this.parked.get(key) === car) this.parked.delete(key);
  }

  /** Кто стоит у целей — заново (из Town.cars: после загрузки, после правки сети). */
  setParked(list: { key: string; car: number }[]): void {
    this.parked.clear();
    for (const x of list) this.parked.set(x.key, x.car);
  }

  /** После загрузки: манёвров и едущих к местам нет (машины в пути не сохраняются). */
  clear(): void {
    this.parked.clear();
    this.reserved.clear();
    this.homing.clear();
    this.moves.length = 0;
  }

  /** Место — место ночёвки чьей-то машины парка. */
  isAssigned(key: string): boolean {
    return this.assignedAll.has(key);
  }

  /** Занято машиной у цели, к нему едут или на нём манёвр. */
  isTaken(key: string): boolean {
    return this.parked.has(key) || this.reserved.has(key);
  }

  /**
   * Место держит не машина парка car: на нём стоит другой гость или его забронировал кто-то другой. Места ночёвки
   * (CarHomes.build) таких не берут: иначе хозяин «дома» встал бы на чужую машину.
   */
  heldByOther(key: string, car: number): boolean {
    const p = this.parked.get(key);
    if (p !== undefined && p !== car) return true;
    const r = this.reserved.get(key);
    return !!r && r.car !== car;
  }

  /** Бронь места key у holder — если места никто не держит (ни стоящий, ни чужая бронь). */
  private reserve(key: string, holder: Holder): boolean {
    const r = this.reserved.get(key);
    if (r === holder) return true;
    if (r || this.occupied(key)) return false;
    this.reserved.set(key, holder);
    return true;
  }

  /** Снять бронь места key — только свою. */
  private release(key: string, holder: Holder): void {
    if (this.reserved.get(key) === holder) this.reserved.delete(key);
  }

  /** Дома ли машина, чьё это место ночёвки (CarHomes): тогда на месте стоит машина. */
  homeAt: (key: string) => boolean = () => false;

  /** На месте сейчас стоит машина (гость или хозяин дома) или к нему едут, на нём манёвр. */
  occupied(key: string): boolean {
    return this.isTaken(key) || (this.assignedAll.has(key) && this.homeAt(key));
  }

  /** Свободно для гостя: не чьё-то место ночёвки, никто не стоит и не едет. */
  isFree(key: string): boolean {
    return !this.assignedAll.has(key) && !this.isTaken(key);
  }

  /** Сколько мест занято на полосах и сколько всего (слой 🅿️): по месту — занято ли (ночёвка — если машина дома). */
  occupancy(): { pos: Vec; total: number; used: number }[] {
    return this.lay().all.map((st) => ({ pos: st.pos, total: 1, used: this.occupied(st.key) ? 1 : 0 }));
  }

  // ---------- Поездки ----------

  /**
   * Куда ехать гостю к цели pos: связь у ближних к ней полос стоянки со свободными местами (не дальше destRange). Какое
   * место — решится на полосе (toCurb, choices). Нет — null.
   */
  visitTarget(pos: Vec, from?: number): { link: GLink; choices: () => CurbStall[] } | null {
    const g = this.host.graph;
    return this.visitFrom(pos, from !== undefined ? (g.outLinks.get(from) ?? []) : []);
  }

  /**
   * То же со связей starts (машина уже в пути — со связи, где она сейчас), без связей skip (там уже искала места); range —
   * насколько далеко от цели. cost — время пути с надбавкой за ходьбу (сравнить с площадками, game/parkSearch.ts).
   */
  visitFrom(pos: Vec, starts: GLink[], skip?: ReadonlySet<number>, range: number = CURB_TRIPS.destRange): { link: GLink; choices: () => CurbStall[]; cost: number; d: number } | null {
    // Связи с местами — по ближнему свободному месту; едет туда, куда быстрее доехать от from (со стороны своего хода
    // места — без круга по кварталу), с надбавкой за то, сколько идти пешком (CURB_TRIPS.walk с за ед.).
    const links = new Map<number, { link: GLink; d: number }>();
    for (const st of this.near(pos, range)) {
      if (!this.isFree(st.key)) continue;
      const slot = this.slotOf(st);
      if (!slot || skip?.has(slot.link.id)) continue;
      const d = dist(st.pos, pos);
      const was = links.get(slot.link.id);
      if (!was || d < was.d) links.set(slot.link.id, { link: slot.link, d });
    }
    if (!links.size) return null;
    const g = this.host.graph;
    let best: { link: GLink; cost: number; d: number } | null = null;
    for (const x of [...links.values()].sort((a, b) => a.d - b.d || a.link.id - b.link.id).slice(0, CURB_TRIPS.tryLinks)) {
      const route = starts.length ? findLaneRoute(g, starts, x.link.toNode!, x.link.id) : null;
      if (starts.length && !route) continue;
      const cost = (route ? routeCost(g, route) : 0) + x.d * CURB_TRIPS.walk;
      if (!best || cost < best.cost) best = { link: x.link, cost, d: x.d };
    }
    if (!best) return null;
    const link = best.link;
    return { link, cost: best.cost, d: best.d, choices: () => this.near(pos, range).filter((st) => this.isFree(st.key) && this.slotOf(st)?.link.id === link.id) };
  }

  /**
   * Мест у цели нет свободных, но они есть (не чьи-то места ночёвки): связь у ближнего — туда машина едет искать (там
   * и выберет, если кто-то уедет). Без связей skip. Нет мест вовсе — null.
   */
  anyLink(pos: Vec, skip?: ReadonlySet<number>, range: number = CURB_TRIPS.destRange): { link: GLink; d: number } | null {
    let best: { link: GLink; d: number } | null = null;
    for (const st of this.near(pos, range)) {
      if (this.assignedAll.has(st.key)) continue;
      const slot = this.slotOf(st);
      if (!slot || skip?.has(slot.link.id)) continue;
      const d = dist(st.pos, pos);
      if (!best || d < best.d || (d === best.d && slot.link.id < best.link.id)) best = { link: slot.link, d };
    }
    return best;
  }

  /** Места (не чьи-то места ночёвки) на связи link не дальше range от pos — для гостя: свободные. */
  freeOn(pos: Vec, link: number, range: number = CURB_TRIPS.destRange): CurbStall[] {
    return this.near(pos, range).filter((st) => this.isFree(st.key) && this.slotOf(st)?.link.id === link);
  }

  /** Путь к месту st от узла from: последняя связь — у места. Не доехать — null. */
  wayTo(from: number, st: CurbStall): { route: number[]; link: GLink } | null {
    const slot = this.slotOf(st);
    const g = this.host.graph;
    const route = slot && findLaneRoute(g, g.outLinks.get(from) ?? [], slot.link.toNode!, slot.link.id);
    return slot && route ? { route, link: slot.link } : null;
  }

  /** Можно ли выехать с места (к нему есть полоса движения). */
  canLeave(st: CurbStall): boolean {
    return !!this.slotOf(st) && !this.reserved.has(st.key);
  }

  /** На полосе стоянки места st идёт манёвр ближе CURB_TRIPS.apart (или машина уже встаёт на место рядом). */
  private crowded(st: CurbStall, self?: Move | Homing): boolean {
    const lk = laneKey(st);
    const close = (o: CurbStall) => laneKey(o) === lk && Math.abs(o.s - st.s) < CURB_TRIPS.apart;
    // Манёвр — пока машина в потоке (выезжает или встаёт); ждущие просвета у бордюра друг другу не мешают.
    if (this.moves.some((m) => m !== self && !!m.sim && close(m.stall))) return true;
    for (const h of this.homing.values()) if (h !== self && h.stall && close(h.stall)) return true;
    return false;
  }

  /**
   * Машина выезжает с места st к узлу target: ждёт просвета на полосе движения, передом встаёт в поток. opt — цвет,
   * крючки, endLink (маршрут кончается связью у следующего места), then — встала и поехала, car — машина парка. trip —
   * откуда куда. Место забронировано кем-то (к нему едут, на нём манёвр) — не выезжает: false.
   */
  leave(
    st: CurbStall,
    target: number,
    trip: { from: TownBuilding; to: TownBuilding },
    opt: { color: string; hooks?: CurbHooks; endLink?: number; then?: (sim: Vehicle) => void; car?: number },
  ): boolean {
    if (this.reserved.has(st.key)) return false;
    const m: Move = { stall: st, kind: 'out', phase: 'wait', leg: null, s: 0, v: 0, wait: 0, color: opt.color, hooks: opt.hooks ?? {}, target, endLink: opt.endLink, then: opt.then, trip, car: opt.car };
    // Бронь выезжающей — пока кузов не вышел из габарита места (stepMove: vacate).
    this.reserved.set(st.key, m);
    this.moves.push(m);
    return true;
  }

  /**
   * Машина в потоке sim едет к полосе стоянки: маршрут кончается связью link (Vehicle.endLink); какое из мест choices
   * занять — решается на полосе у них (ближнее, до которого ещё успеть остановиться). Не вышло — hooks.missed.
   */
  toCurb(sim: Vehicle, link: number, choices: () => CurbStall[], hooks: CurbHooks, car?: number): void {
    // Уже ехала к месту (поиск места перенаправил её) — прежняя бронь снимается.
    const was = this.homing.get(sim.id);
    if (was?.stall) this.release(was.stall.key, was);
    sim.endLink = link;
    delete sim.endLeft;
    this.homing.set(sim.id, { link, choices, hooks, color: sim.color, car });
  }

  /** Едет ли машина в потоке к полосе стоянки. */
  isHoming(simId: number): boolean {
    return this.homing.has(simId);
  }

  /** Машина в потоке кончила поездку или потерялась: место её больше не ждёт. */
  forget(simId: number): void {
    const h = this.homing.get(simId);
    if (!h) return;
    this.homing.delete(simId);
    if (h.stall) this.release(h.stall.key, h);
    h.hooks.missed?.();
  }

  /** Не свернёт к месту (проехала, дорогу поменяли): поездка кончается у узла, как у всех. */
  private cancel(sim: Vehicle): void {
    delete sim.endLink;
    if (sim.holdDist !== undefined) this.host.traffic.release(sim);
    sim.blinker = 0;
    this.forget(sim.id);
  }

  // ---------- Такт ----------

  /** Такт — после движения (traffic.step): подъезжающие выбирают место и встают, манёвры — дальше. */
  step(dt: number): void {
    if (this.homing.size) this.stepHoming();
    for (let i = 0; i < this.moves.length; i++) {
      if (this.stepMove(this.moves[i], dt)) continue;
      this.moves.splice(i--, 1);
    }
  }

  private stepHoming(): void {
    const traffic = this.host.traffic;
    const L = this.host.car.length;
    for (const [id, h] of [...this.homing]) {
      const sim = traffic.vehicles.get(id);
      if (!sim) {
        this.forget(id);
        continue;
      }
      if (sim.endLink !== h.link) {
        this.cancel(sim);
        continue;
      }
      if (!h.stall) {
        const lane = sim.onMovement ? undefined : traffic.currentLane(sim);
        if (!lane || lane.link !== h.link) continue;
        const stop = (sim.v * sim.v) / (2 * HOLD_BRAKE) + 0.5;
        let best: { st: CurbStall; mode: 'fwd' | 'rev'; nose: number } | null = null;
        for (const st of h.choices()) {
          const slot = this.slotOf(st);
          // Занятое (стоит гость или хозяин дома, бронь) — мимо: ищет дальше.
          if (!slot || slot.link.id !== lane.link || this.occupied(st.key) || this.crowded(st, h)) continue;
          const mode = this.modeOf(st, slot);
          if (!mode) continue;
          const nose = (mode === 'fwd' ? slot.u - CURB_TRIPS.fwdRun : slot.u + CURB_TRIPS.revRun) + L / 2;
          if (nose - sim.s < stop || nose > lane.length - 1) continue;
          if (!best || nose < best.nose) best = { st, mode, nose };
        }
        if (!best) {
          // Мест впереди больше нет — едет к узлу, поездка кончится там.
          if (lane.length - sim.s < 40 || !h.choices().length) this.cancel(sim);
          continue;
        }
        // Не у бордюра (широкая улица) — сперва перестроится вправо: на последней связи пути машина держится правее.
        if (lane.id !== this.slotOf(best.st)!.lane.id || !this.reserve(best.st.key, h)) continue;
        h.stall = best.st;
        h.mode = best.mode;
        h.nose = best.nose;
        // Передом — сворачивает с ходу (тормозит к точке чуть дальше начала манёвра), задом — встаёт у соседнего места.
        traffic.holdAfter(sim, best.nose + (best.mode === 'fwd' ? FWD_ROLL : 0) - sim.s);
        sim.lcCooldown = 1e9;
        continue;
      }
      sim.blinker = 1;
      const rolling = h.mode === 'fwd' && !sim.onMovement && sim.s >= (h.nose ?? Infinity) - 0.3;
      if (!rolling && !traffic.held(sim)) continue;
      const slot = this.slotOf(h.stall);
      if (!slot || sim.lane !== slot.lane.id) {
        this.cancel(sim);
        continue;
      }
      const st = h.stall;
      // Бронь — её (снять чужую нельзя: clear после загрузки, правка сети); нет — не встаёт, едет дальше.
      if (this.reserved.get(st.key) !== h) {
        this.cancel(sim);
        continue;
      }
      this.homing.delete(id);
      const c0 = sub(sim.pos, scale(sim.dir, L / 2));
      const k = 0.42 * dist(c0, st.pos);
      const fwd = h.mode === 'fwd';
      const leg = fwd
        ? bezier(c0, add(c0, scale(st.dir, k)), sub(st.pos, scale(st.dir, k)), st.pos, false, SPEED.fwdIn)
        : bezier(c0, sub(c0, scale(st.dir, k)), add(st.pos, scale(st.dir, k)), st.pos, true, SPEED.revIn);
      traffic.holdAfter(sim, 0);
      const v0 = fwd ? Math.min(sim.v, SPEED.fwdIn) : 0;
      const m: Move = { stall: st, kind: 'in', phase: 'road', leg, s: 0, v: v0, wait: 0, color: sim.color, hooks: h.hooks, sim, dropAt: fwd ? leg.len * 0.55 : leg.len, car: h.car };
      // Бронь переходит к манёвру: место занято, пока машина не встанет на него (done).
      this.reserved.set(st.key, m);
      this.moves.push(m);
    }
  }

  /**
   * Как встать на место st: передом, если место перед ним (по ходу — позади) тоже свободно и есть где начать (fwd);
   * иначе задом от соседнего впереди (rev). Негде — null.
   */
  private modeOf(st: CurbStall, slot: CurbSlot): 'fwd' | 'rev' | null {
    const L = this.host.car.length;
    // Место перед этим по ходу движения: при ходе по оси (a→b) — с номером на 1 меньше, против — больше.
    const before = st.idx - (this.flowSign(st) > 0 ? 1 : -1);
    const prev = this.laneStalls(st).find((o) => o.idx === before);
    const room = (u: number) => u - L / 2 >= 1 && u + L / 2 <= slot.lane.length - 1;
    if (prev && !this.occupied(prev.key) && room(slot.u - CURB_TRIPS.fwdRun)) return 'fwd';
    return room(slot.u + CURB_TRIPS.revRun) ? 'rev' : null;
  }

  /** Ход полосы стоянки места по оси полотна (1 — по a→b). */
  private flowSign(st: CurbStall): number {
    return this.host.net.corridors.get(st.corridor)?.lanes[st.lane]?.flow ?? 1;
  }

  private stepMove(m: Move, dt: number): boolean {
    const traffic = this.host.traffic;
    if (m.sim && !traffic.vehicles.has(m.sim.id)) return this.done(m);
    if (m.phase === 'wait') return this.stepWait(m, dt);
    if (m.phase === 'pause') {
      m.wait += dt;
      this.pose(m);
      if (m.wait < PAUSE) return true;
      const sim = m.sim!;
      traffic.release(sim);
      sim.lcCooldown = 0.5;
      sim.blinker = 0;
      m.then?.(sim);
      return this.done(m);
    }
    const leg = m.leg!;
    m.v = Math.max(0.3, Math.min(leg.vmax, m.v + SPEED.accel * dt, Math.sqrt(2 * SPEED.brake * Math.max(0, leg.len - m.s))));
    m.s = Math.min(leg.len, m.s + m.v * dt);
    if (m.kind === 'in' && m.sim && m.s >= (m.dropAt ?? leg.len) - 1e-6) {
      // Кузов ушёл с полосы движения — поездка в потоке кончилась, дальше — только рисунок.
      const sim = m.sim;
      traffic.remove(sim);
      traffic.arrivals++;
      traffic.totalTripTime += sim.tripTime;
      this.host.gone(sim);
      m.sim = undefined;
      m.phase = 'yard';
    }
    this.pose(m);
    if (m.kind === 'out') this.vacate(m);
    if (m.s < leg.len) return true;
    if (m.kind === 'out') {
      m.phase = 'pause';
      m.wait = 0;
      return true;
    }
    m.hooks.arrived?.(m.stall);
    return this.done(m);
  }

  /** Выезд: ждёт просвета; дождалась — встаёт в поток (стоит, пока выезжает). */
  private stepWait(m: Move, dt: number): boolean {
    m.wait += dt;
    const traffic = this.host.traffic;
    const L = this.host.car.length;
    const slot = this.slotOf(m.stall);
    const uEnd = slot ? slot.u + CURB_TRIPS.exitRun : 0;
    const fits = !!slot && uEnd + L / 2 <= slot.lane.length - 1;
    if (!fits || m.wait > CURB_TRIPS.maxWait) {
      m.hooks.stayed?.();
      return this.done(m);
    }
    if (m.wait < LOOK || this.crowded(m.stall, m) || !traffic.clearToJoin(slot!.lane.id, slot!.u - L / 2 - 1, uEnd + L / 2 + 1)) return true;
    const sim = traffic.placeOnLane({ ...this.host.car, color: m.color, targetNode: m.target!, endLink: m.endLink }, slot!.lane.id, uEnd + L / 2);
    if (!sim) {
      m.hooks.stayed?.();
      return this.done(m);
    }
    traffic.holdAfter(sim, 0);
    if (m.endLink !== undefined) sim.endLink = m.endLink;
    sim.lcCooldown = 1e9;
    this.host.own(sim, m.trip!);
    m.hooks.joined?.(sim);
    const end = this.host.graph.lanePose(slot!.lane, uEnd);
    const c0 = m.stall.pos;
    const k = 0.42 * dist(c0, end.pos);
    m.sim = sim;
    m.phase = 'road';
    m.leg = bezier(c0, add(c0, scale(m.stall.dir, k)), sub(end.pos, scale(end.dir, k)), end.pos, false, SPEED.out);
    m.s = 0;
    m.v = 0;
    this.pose(m);
    return true;
  }

  private done(m: Move): false {
    this.release(m.stall.key, m);
    return false;
  }

  /** Выезд: кузов вышел из габарита места — бронь снята, на место можно вставать (манёвр ещё идёт). */
  private vacate(m: Move): void {
    if (!m.leg || this.reserved.get(m.stall.key) !== m) return;
    const { c, h } = legPose(m.leg, m.s);
    const spec = this.host.car;
    if (!boxesOverlap(stallBox(m.stall), { c, d: h, hl: spec.length / 2, hw: spec.width / 2 })) this.release(m.stall.key, m);
  }

  /** Машина в потоке на манёвре — там, где она на нём (поток держит её на месте: holdAfter). */
  private pose(m: Move): void {
    const sim = m.sim;
    if (!sim || !m.leg) return;
    const { c, h } = legPose(m.leg, m.s);
    const nose = add(c, scale(h, sim.length / 2));
    sim.pos = nose;
    sim.dir = h;
    sim.rear = sub(nose, scale(h, steerBase(sim.body) * sim.length));
    sim.v = 0;
    sim.blinker = m.kind === 'in' ? 1 : -1;
  }

  /**
   * Манёвр на месте key (у места — машина видна манёвром, а не стоящей): место ещё за ним (бронь). Выезжающая, чей
   * кузов уже вне места, — нет: на место мог встать другой.
   */
  moving(key: string): boolean {
    const r = this.reserved.get(key);
    return !!r && this.moves.includes(r as Move);
  }

  /** Бронь места: есть ли и машины ли парка car (подъезд или манёвр). Для проверок. */
  holder(key: string): { car?: number; kind: 'homing' | 'in' | 'out' } | null {
    const r = this.reserved.get(key);
    if (!r) return null;
    return { car: r.car, kind: 'kind' in r ? r.kind : 'homing' };
  }

  // ---------- Рисунок ----------

  /** Машины на манёвре вне потока (у места) в кадре box. */
  looks(box: [number, number, number, number]): GarageLook[] {
    const out: GarageLook[] = [];
    const spec = this.host.car;
    for (const m of this.moves) {
      if (m.sim) continue;
      let pos: Vec;
      let dir: Vec;
      if (m.leg) {
        const { c, h } = legPose(m.leg, m.s);
        pos = add(c, scale(h, spec.length / 2));
        dir = h;
      } else {
        pos = add(m.stall.pos, scale(m.stall.dir, spec.length / 2));
        dir = m.stall.dir;
      }
      if (pos.x < box[0] - 10 || pos.x > box[2] + 10 || pos.y < box[1] - 10 || pos.y > box[3] + 10) continue;
      const look: VehicleLook = { ...spec, color: m.color, pos, dir };
      out.push({ look });
    }
    return out;
  }

  /**
   * Границы мест в кадре — буквой «Т» (stallTee): у каждого места — оба края, у соседних мест граница общая и в ответе
   * одна. Отрезки: поперечная линия и засечка.
   */
  marks(box: [number, number, number, number]): [Vec, Vec][] {
    const out: [Vec, Vec][] = [];
    const net = this.host.net;
    const seen = new Set<string>();
    for (const st of this.lay().all) {
      if (st.pos.x < box[0] - 10 || st.pos.x > box[2] + 10 || st.pos.y < box[1] - 10 || st.pos.y > box[3] + 10) continue;
      const c = net.corridors.get(st.corridor);
      const P = c?.lanes[st.lane];
      if (!c || !P) continue;
      for (const k of [0, 1]) {
        const key = `${laneKey(st)}:${st.idx + k}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(...stallTee(c, P, st.s + (k - 0.5) * CURB.stallLen));
      }
    }
    return out;
  }
}

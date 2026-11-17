import { hash } from '../core/math';
import { add, dist, scale, type Vec } from '../core/vec';
import type { Vehicle, VehicleSpec } from '../sim/vehicle';
import type { ShopCar, Town, TownBuilding, TownCar } from '../world/entities';
import { drivewayOf, type Driveway } from '../world/houseAccess';
import { flatsOf, formOf } from '../world/townForms';
import { yardLotOf, yardSpots } from '../world/yardLots';
import { carSpot, GARAGE_TRIPS, type CarSpot, type GarageLook, type Garages, type GarageSlot, type MoveHooks } from './garages';
import { stallKey, type FleetBack, type FleetVisit } from './shopParking';
import type { CurbStall } from '../lanes/curb';
import type { GLink } from '../lanes/graph';
import { CURB_TRIPS, type CurbHooks, type CurbParking } from './curbParking';

/**
 * Парк машин жителей: где машина ночует и куда едет (docs/PARKING.md, этап 1). У каждой машины жителя — свой дом и
 * своё место ночёвки; поездка начинается с этого места и кончается на нём, машин «из ниоткуда» (появились у узла,
 * исчезли у узла) меньше.
 *
 * Парк стабилен: ключ машины — id дома × 64 + номер. Частный дом и дача — машина у дома с гаражом или площадкой, у
 * GARAGE_TRIPS.secondCar домов с гаражом — вторая, перед воротами. Многоквартирный дом — round(квартир × 0,15).
 * Место ночёвки — по порядку: свой гараж или площадка → дворовая стоянка дома (world/yardLots.ts) → бокс в
 * гаражах в 700 ед. (≈ 420 м); мест не хватило — машина без места: её поездки, как прежде, от узла и до узла.
 * Назначается раз — по геометрии и хешу id дома (какое место двора), без генератора случайных чисел партии.
 *
 * Поездка: общий генератор партии тянет столько же чисел, что прежде (дом, цель, цвет — Game.spawnCitizenTrip), дом —
 * по весу числа машин (pickHome), остальное — хешем seed, города и номера поездки (Town.carTrips). С вероятностью
 * ready / (ready + backK · машин города с местом) это возвращение: машина, что отстояла у чужой цели (ready — срок
 * вышел), едет от неё на своё место. Иначе — выезд: машина дома встаёт в поток со своего места (Garages.leave) и
 * едет к цели; у узла цели «пропадает» — стоит там (TownCar.until — сколько), на стоянке магазина — стоит на месте
 * и потом едет на своё место (ShopHost.backHome).
 *
 * Не дома — Town.cars (сохраняются с городом); кто сейчас едет или на манёвре — только в памяти (moving): после
 * загрузки все такие — у цели, и едут домой, как прочие. Стоящие машины — только данные: в такт — куча отъездов
 * (heap: у кого срок у цели кончается) и манёвры Garages.
 */
export const CAR_HOMES = {
  /** Машин на квартиру многоквартирного дома. */
  perFlat: 0.15,
  /** Бокс — не дальше стольких ед. от дома (≈ 420 м; единица карты — 0,6 м). */
  boxRange: 700,
  /** Возвращение — с вероятностью ready / (ready + backK · машин с местом): чем больше отстояли у цели, тем чаще. */
  backK: 0.2,
  /**
   * Сколько машина стоит у цели, с игры (минута — месяц), прежде чем может ехать домой — считая с выезда: у магазина и
   * рынка, на работе, в гостях (жилой дом), у ратуши — от и до. Поездка по городу — 0,5–1,5 минуты: дольше нескольких
   * минут машины копились бы у целей, а дома машин не оставалось бы.
   */
  stay: { shop: [20, 50], work: [30, 90], home: [25, 70], hall: [30, 30] } as Record<'shop' | 'work' | 'home' | 'hall', [number, number]>,
  /** Машины дома с местом нет (все в разъездах) — столько попыток другим домом города (по весу машин). */
  tries: 3,
  /** Номеров машин на дом — меньше 64 (ключ — дом × 64 + номер). */
  maxPerHome: 62,
  /**
   * Вес дома при выборе поездки — машин в степени weightPow. По числу машин (1) поездки из кварталов панелек (по 10–20
   * машин на дом) идут втрое чаще прежнего, и их улицы к пятому-восьмому месяцу встают у перекрёстков (seed 7:
   * прибытий −21 %, townTraffic.test); по корню (0,5) — −11 %, как без парка (−9 %): дом с машинами по-прежнему чаще.
   */
  weightPow: 0.5,
};

/** Ключ машины: дом и номер. */
export const carKey = (home: number, k: number): number => home * 64 + k;
/** Дом машины по ключу. */
export const carHomeOf = (key: number): number => Math.floor(key / 64);
/** Ключ места перед воротами гаража (вторая машина) и ворот двора дома — как у мест стоянки (отрицательные). */
const APRON = 62;
const GATE = 63;

export type PlaceKind = 'garage' | 'pad' | 'apron' | 'stall' | 'yard' | 'box' | 'curb';

/** Место ночёвки машины. */
export interface Place {
  /**
   * Место на полосе стоянки у улицы (kind 'curb', game/curbParking.ts): выезд и въезд — манёвром у бордюра, а не через
   * заезд (spot у такого места — только для ключа и рисунка).
   */
  curb?: CurbStall;
  /**
   * Место манёвра у Garages: заезд, где встаёт машина. У ворот двора и гаражных боксов — одно на все их машины (одна
   * машина в воротах за раз), у остальных — своё.
   */
  spot: CarSpot;
  kind: PlaceKind;
  /** Где видна машина дома: нос и курс; null — не видна (в гараже, в боксе). */
  look: { pos: Vec; dir: Vec } | null;
  /** Соседние места (ключи Garages): пока там манёвр, сюда не заехать и отсюда не выехать — кузова заденут. */
  near: number[];
  /** Дом, у которого место (бокс — гаражи). */
  at: TownBuilding;
}

/** Машина парка: ключ, дом, цвет, место ночёвки (нет — без места). */
export interface FleetCar {
  key: number;
  home: TownBuilding;
  color: string;
  place: Place | null;
}

/** Парк машин города (по его домам; дома прибавились или убавились — заново). */
interface Fleet {
  of: TownBuilding[];
  n: number;
  cars: FleetCar[];
  byKey: Map<number, FleetCar>;
  byHome: Map<number, FleetCar[]>;
  byId: Map<number, TownBuilding>;
  /** Жилые дома по порядку города и сумма весов (машин в степени weightPow) нарастающим итогом — выбор дома по весу. */
  homes: TownBuilding[];
  cum: number[];
  /** Машин с местом. */
  placed: number;
  /** Дворы и гаражи с местами — сколько мест (слой 🅿️). */
  lots: { b: TownBuilding; total: number }[];
  /** Где места — рамка (рисунок: город в кадре). */
  box: [number, number, number, number];
  /** По какой раскладке мест на полосах стоянки назначены места ночёвки (CurbParking.version). */
  curbVer: number;
}

/** Не дома — по городу: что сохраняется (Town.cars), по ключу машины, куча отъездов по сроку и кто его отстоял. */
interface Away {
  list: TownCar[];
  byCar: Map<number, TownCar>;
  heap: TownCar[];
  ready: TownCar[];
}

/** Что решено о поездке жителя: возвращение машины на её место (от дома from) или выезд с места. */
export type FleetTrip =
  /** curb — машина стоит у цели на полосе стоянки: уезжает с этого места (CarHomes.leaveCurb). */
  | { kind: 'back'; car: FleetCar; town: Town; from: TownBuilding | null; curb?: CurbStall }
  | { kind: 'out'; car: FleetCar; town: Town };

/** Что парку нужно от игры. */
export interface CarHomesHost {
  readonly seed: number;
  readonly time: number;
  readonly towns: readonly Town[];
  readonly car: Omit<VehicleSpec, 'color'>;
  readonly colors: readonly string[];
}

/** Номер поездки города → зерно хеша: по seed партии, без общего генератора. */
function tripSeed(seed: number, town: number, n: number): number {
  return (Math.imul(seed >>> 0, 0x5bd1e995) ^ Math.imul(town + 3, 0x1b873593) ^ Math.imul(n, 0xcc9e2d51)) >>> 0;
}

/** Куча по сроку (until), при равном — по ключу машины: порядок отъездов не зависит от того, как шли такты. */
function before(a: TownCar, b: TownCar): boolean {
  const ua = a.until ?? 0;
  const ub = b.until ?? 0;
  return ua < ub || (ua === ub && a.car < b.car);
}

function heapPush(h: TownCar[], x: TownCar): void {
  h.push(x);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!before(h[i], h[p])) break;
    [h[i], h[p]] = [h[p], h[i]];
    i = p;
  }
}

function heapPop(h: TownCar[]): TownCar | undefined {
  const top = h[0];
  const last = h.pop();
  if (!h.length || !last) return top;
  h[0] = last;
  let i = 0;
  for (;;) {
    const l = 2 * i + 1;
    const r = l + 1;
    let m = i;
    if (l < h.length && before(h[l], h[m])) m = l;
    if (r < h.length && before(h[r], h[m])) m = r;
    if (m === i) break;
    [h[i], h[m]] = [h[m], h[i]];
    i = m;
  }
  return top;
}

/** Сколько стоит у цели: по типу дома цели, u — хеш 0…1. */
export function stayAt(dest: TownBuilding, u: number): number {
  const form = formOf(dest);
  const kind = dest.kind === 'res' ? 'home' : form === 'shop' || form === 'store' || form === 'market' ? 'shop' : form === 'hall' || form === 'temple' ? 'hall' : 'work';
  const [lo, hi] = CAR_HOMES.stay[kind];
  return lo + (hi - lo) * u;
}

/** Машина на месте у заезда d: нос — на полдлины впереди середины, курс — от улицы. */
function lookAt(d: Driveway, L: number): { pos: Vec; dir: Vec } {
  return { pos: add(d.spot, scale(d.dir, L / 2)), dir: d.dir };
}

export class CarHomes {
  private fleets = new Map<number, Fleet>();
  private aways = new Map<number, Away>();
  /** Машины (ключи), что сейчас на манёвре у места или в потоке. */
  private moving = new Set<number>();
  /** Машина в потоке (id) → машина парка; home — едет на своё место. */
  private driving = new Map<number, { car: number; town: Town; home: boolean }>();

  /** По какой раскладке мест полос стоянки сверены машины у целей (TownCar.curb). */
  private curbSeen = -1;
  private curbLists: (TownCar[] | undefined)[] = [];
  /** Машины парка (ключи), что встают на полосу стоянки у цели: свернув с полосы, ещё на манёвре — не «у цели». */
  private curbIn = new Set<number>();
  /** Место ночёвки на полосе стоянки → чья машина (город и ключ). */
  private curbOwner = new Map<string, { town: Town; car: number }>();

  constructor(
    private host: CarHomesHost,
    private garages: Garages,
    private curb: CurbParking | null = null,
  ) {
    if (curb) {
      curb.homeAt = (key) => {
        const o = this.curbOwner.get(key);
        return !!o && this.isHome(o.town, o.car);
      };
    }
  }

  /** Нынешняя раскладка мест на полосах стоянки (сеть поправили — номер другой). */
  private curbVer(): number {
    if (!this.curb) return 0;
    this.curb.stalls();
    return this.curb.version;
  }

  /** Парк города: машины домов и их места. */
  fleet(town: Town): Fleet {
    const hit = this.fleets.get(town.id);
    const ver = this.curbVer();
    if (hit && hit.of === town.buildings && hit.n === town.buildings.length && hit.curbVer === ver) return hit;
    const f = this.build(town);
    this.fleets.set(town.id, f);
    return f;
  }

  private build(town: Town): Fleet {
    const L = this.host.car.length;
    const colors = this.host.colors;
    const colorOf = (key: number) => colors[Math.floor(hash(key, 29) * colors.length)];
    const homes = town.buildings.filter((b) => b.kind === 'res');
    const byId = new Map(town.buildings.map((b) => [b.id, b]));
    // Гаражные боксы города: ворота (одно место манёвра на все боксы) и сколько боксов свободно.
    const boxes: { b: TownBuilding; spot: CarSpot; free: number }[] = [];
    const lots: Fleet['lots'] = [];
    for (const b of town.buildings) {
      if (formOf(b) !== 'garages') continue;
      const lot = yardLotOf(b);
      const ys = lot && yardSpots(b, lot, L);
      if (!ys?.gate || !ys.spots.length) continue;
      boxes.push({ b, spot: carSpot(stallKey(b.id, GATE), b, ys.gate, false, '#888888', L), free: ys.spots.length });
      lots.push({ b, total: ys.spots.length });
    }
    // Полосы стоянки: сколько мест на каждой и сколько из них уже чьи-то места ночёвки (этого города и прочих).
    const curb = this.curb;
    const mine = new Set<string>();
    const laneTotal = new Map<string, number>();
    const laneUsed = new Map<string, number>();
    const laneOf = (st: CurbStall) => `${st.corridor}:${st.lane}`;
    if (curb) {
      for (const st of curb.stalls()) {
        laneTotal.set(laneOf(st), (laneTotal.get(laneOf(st)) ?? 0) + 1);
        if (curb.assignedElsewhere(st.key, town.id)) laneUsed.set(laneOf(st), (laneUsed.get(laneOf(st)) ?? 0) + 1);
      }
    }
    const curbHome = (b: TownBuilding, color: string): Place | null => {
      if (!curb) return null;
      let best: CurbStall | null = null;
      for (const st of curb.near(b.fp.center, CURB_TRIPS.homeRange)) {
        if (mine.has(st.key) || curb.assignedElsewhere(st.key, town.id) || !curb.slotOf(st)) continue;
        if ((laneUsed.get(laneOf(st)) ?? 0) + 1 > CURB_TRIPS.homeShare * (laneTotal.get(laneOf(st)) ?? 0)) continue;
        const d = dist(st.pos, b.fp.center);
        if (!best || d < dist(best.pos, b.fp.center) || (d === dist(best.pos, b.fp.center) && st.key < best.key)) best = st;
      }
      if (!best) return null;
      mine.add(best.key);
      laneUsed.set(laneOf(best), (laneUsed.get(laneOf(best)) ?? 0) + 1);
      const d: Driveway = { building: b.id, curb: best.pos, gate: best.pos, dir: best.dir, width: 4.6, spot: best.pos, garage: false };
      return { curb: best, spot: carSpot(NaN, b, d, true, color, L), kind: 'curb', look: { pos: add(best.pos, scale(best.dir, L / 2)), dir: best.dir }, near: [], at: b };
    };
    const byHome = new Map<number, FleetCar[]>();
    // Боксы — по порядку id домов: новый дом не отбирает бокс у старого.
    for (const b of [...homes].sort((x, y) => x.id - y.id)) {
      const list: FleetCar[] = [];
      const car = (k: number, place: Place | null) => list.push({ key: carKey(b.id, k), home: b, color: colorOf(carKey(b.id, k)), place });
      const form = formOf(b);
      if (form === 'cottage' || form === 'dacha') {
        const d = drivewayOf(b);
        if (d) {
          const main: Place = { spot: carSpot(b.id, b, d, !d.garage, colorOf(carKey(b.id, 0)), L), kind: d.garage ? 'garage' : 'pad', look: d.garage ? null : lookAt(d, L), near: [], at: b };
          car(0, main);
          if (d.garage && hash(b.id, 18) < GARAGE_TRIPS.secondCar) {
            // Вторая — перед воротами: пока она дома, первой из гаража не выехать (и в гараж не въехать).
            const apron = carSpot(stallKey(b.id, APRON), b, d, true, colorOf(carKey(b.id, 1)), L);
            car(1, { spot: apron, kind: 'apron', look: lookAt(d, L), near: [b.id], at: b });
            main.near = [apron.key];
          }
        }
      } else {
        const n = Math.min(CAR_HOMES.maxPerHome, Math.round(flatsOf(b) * CAR_HOMES.perFlat));
        const lot = yardLotOf(b);
        const ys = lot ? yardSpots(b, lot, L) : null;
        if (ys?.spots.length) lots.push({ b, total: ys.spots.length });
        const gate = ys?.gate ? carSpot(stallKey(b.id, GATE), b, ys.gate, false, '#888888', L) : null;
        // Места двора — машинам по хешу (не подряд от края): полупустой двор — вперемешку.
        const order = ys ? ys.spots.map((_, i) => i).sort((x, y) => hash(b.id, 200 + x) - hash(b.id, 200 + y)) : [];
        let next = 0;
        for (let k = 0; k < n; k++) {
          let place: Place | null = null;
          while (!place && next < order.length) {
            const i = order[next++];
            const s = ys!.spots[i];
            const look = { pos: s.nose, dir: s.dir };
            if (s.drive) {
              const near = [i - 1, i + 1].filter((j) => ys!.spots[j]?.row === s.row && ys!.spots[j].drive).map((j) => stallKey(b.id, j));
              place = { spot: carSpot(stallKey(b.id, i), b, s.drive, true, colorOf(carKey(b.id, k)), L), kind: 'stall', look, near, at: b };
            } else if (gate) place = { spot: gate, kind: 'yard', look, near: [], at: b };
          }
          // Двор полон (или его нет) — место на полосе стоянки рядом (не больше CURB_TRIPS.homeShare мест полосы).
          if (!place) place = curbHome(b, colorOf(carKey(b.id, k)));
          if (!place) {
            // И там нет — бокс в ближних гаражах.
            let best: (typeof boxes)[number] | null = null;
            let bestD = CAR_HOMES.boxRange;
            for (const x of boxes) {
              const dd = dist(x.b.fp.center, b.fp.center);
              if (x.free > 0 && dd < bestD) [best, bestD] = [x, dd];
            }
            if (best) {
              best.free--;
              place = { spot: best.spot, kind: 'box', look: null, near: [], at: best.b };
            }
          }
          car(k, place);
        }
      }
      if (list.length) byHome.set(b.id, list);
    }
    const cars: FleetCar[] = [];
    const cum: number[] = [];
    let sum = 0;
    for (const b of homes) {
      const list = byHome.get(b.id) ?? [];
      cars.push(...list);
      sum += list.length ** CAR_HOMES.weightPow;
      cum.push(sum);
    }
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    let placed = 0;
    for (const c of cars) {
      if (!c.place) continue;
      placed++;
      const p = c.place.look?.pos ?? c.place.spot.d.gate;
      box[0] = Math.min(box[0], p.x);
      box[1] = Math.min(box[1], p.y);
      box[2] = Math.max(box[2], p.x);
      box[3] = Math.max(box[3], p.y);
    }
    curb?.setAssigned(town.id, mine);
    for (const [k, o] of this.curbOwner) if (o.town.id === town.id) this.curbOwner.delete(k);
    for (const c of cars) if (c.place?.curb) this.curbOwner.set(c.place.curb.key, { town, car: c.key });
    return { of: town.buildings, n: town.buildings.length, cars, byKey: new Map(cars.map((c) => [c.key, c])), byHome, byId, homes, cum, placed, lots, box, curbVer: this.curbVer() };
  }

  /** Не дома — по городу (из Town.cars; первый раз — разложить по куче и отстоявшим). */
  private away(town: Town): Away {
    let a = this.aways.get(town.id);
    if (a && a.list === town.cars) return a;
    const list = (town.cars ??= []);
    a = { list, byCar: new Map(), heap: [], ready: [] };
    const now = this.host.time;
    const ready: TownCar[] = [];
    for (const e of list) {
      a.byCar.set(e.car, e);
      if ((e.until ?? 0) > now) heapPush(a.heap, e);
      else ready.push(e);
    }
    a.ready = ready.sort((x, y) => (before(x, y) ? -1 : 1));
    this.aways.set(town.id, a);
    return a;
  }

  /**
   * После загрузки: старое сохранение (Town.garageTrips, Town.garageAway — прежний учёт гаражей) — номер поездки и
   * уехавшие машины частных домов переносятся в парк; остальные машины — дома. Всё, что было в пути, — у цели.
   */
  load(towns: readonly Town[]): void {
    this.fleets.clear();
    this.aways.clear();
    this.moving.clear();
    this.driving.clear();
    this.curbIn.clear();
    this.curbOwner.clear();
    const now = this.host.time;
    for (const town of towns) {
      if (town.carTrips === undefined && town.garageTrips !== undefined) town.carTrips = town.garageTrips;
      if (!town.cars && town.garageAway?.length) {
        // Уезжала машина перед воротами (вторая), если она есть, иначе — та, что в гараже или на площадке.
        const f = this.fleet(town);
        town.cars = town.garageAway.flatMap((id) => {
          const list = f.byHome.get(id) ?? [];
          const c = list.find((x) => x.place?.kind === 'apron') ?? list[0];
          return c ? [{ car: c.key, until: now }] : [];
        });
      }
      delete town.garageTrips;
      delete town.garageAway;
    }
    this.curb?.clear();
    this.curbSeen = -1;
    this.syncCurb();
  }

  /**
   * Машины у целей на полосах стоянки (TownCar.curb) — по нынешней раскладке мест: место с тем же ключом там же, а нет —
   * ближнее к прежнему положению (TownCar.cp) не дальше 3 ед.; не нашлось — машина просто у цели («в разъездах»).
   */
  private syncCurb(): void {
    const curb = this.curb;
    if (!curb) return;
    const ver = this.curbVer();
    // Списки машин не дома те же (не загрузка, не Ctrl+Z) и места те же — сверять нечего.
    const lists = this.host.towns.map((t) => t.cars);
    if (ver === this.curbSeen && lists.length === this.curbLists.length && lists.every((x, i) => x === this.curbLists[i])) return;
    this.curbSeen = ver;
    this.curbLists = lists;
    const list: { key: string; car: number }[] = [];
    const taken = new Set<string>();
    for (const town of this.host.towns) {
      for (const e of town.cars ?? []) {
        if (e.curb === undefined) continue;
        const st = curb.find(e.curb, e.cp ? { x: e.cp[0], y: e.cp[1] } : undefined);
        if (!st || taken.has(st.key)) {
          delete e.curb;
          delete e.cp;
          continue;
        }
        e.curb = st.key;
        e.cp = [Math.round(st.pos.x * 10) / 10, Math.round(st.pos.y * 10) / 10];
        taken.add(st.key);
        list.push({ key: st.key, car: e.car });
      }
    }
    curb.setParked(list);
  }

  /** Машина дома (не в Town.cars и не в пути)? */
  isHome(town: Town, key: number): boolean {
    return !this.moving.has(key) && !this.away(town).byCar.has(key);
  }

  /** Машина в пути или на манёвре. */
  isMoving(key: number): boolean {
    return this.moving.has(key);
  }

  /** Запись машины не дома (Town.cars); нет — дома или в пути от дома. */
  awayOf(town: Town, key: number): TownCar | undefined {
    return this.away(town).byCar.get(key);
  }

  /** Машина уехала (или стоит у цели): запись в Town.cars и в кучу отъездов. */
  private goAway(town: Town, e: TownCar): void {
    const a = this.away(town);
    const old = a.byCar.get(e.car);
    if (old) a.list.splice(a.list.indexOf(old), 1);
    if (old?.curb !== undefined && old.curb !== e.curb) this.curb?.unpark(old.curb, old.car);
    a.list.push(e);
    a.byCar.set(e.car, e);
    if ((e.until ?? 0) > this.host.time) heapPush(a.heap, e);
    else a.ready.push(e);
  }

  /** Машина дома: из Town.cars (куча и отстоявшие чистятся по ходу — запись больше не та). */
  private settle(town: Town, key: number): void {
    this.moving.delete(key);
    const a = this.away(town);
    const e = a.byCar.get(key);
    if (!e) return;
    // Стояла у цели на полосе стоянки — место свободно.
    if (e.curb !== undefined) this.curb?.unpark(e.curb, e.car);
    a.byCar.delete(key);
    const i = a.list.indexOf(e);
    if (i >= 0) a.list.splice(i, 1);
  }

  /** Такт: у кого срок у цели вышел — в отстоявшие (куча — по сроку, потом по ключу машины). */
  step(): void {
    const now = this.host.time;
    // Сеть поправили — машины у целей на полосах стоянки ищут свои места заново.
    this.syncCurb();
    for (const town of this.host.towns) {
      const a = this.aways.get(town.id);
      if (!a || a.list !== town.cars) continue;
      while (a.heap.length && (a.heap[0].until ?? 0) <= now) {
        const e = heapPop(a.heap)!;
        if (a.byCar.get(e.car) === e) a.ready.push(e);
      }
    }
  }

  /**
   * Дом поездки по весу числа машин (homes — жилые дома города по порядку): u — то же число общего генератора, что
   * выбирало дом с равным весом. Машин в городе нет — с равным весом.
   */
  pickHome(town: Town, homes: readonly TownBuilding[], u: number): TownBuilding {
    const f = this.fleet(town);
    const total = f.cum[f.cum.length - 1] ?? 0;
    if (!total || f.homes.length !== homes.length) return homes[Math.floor(u * homes.length)];
    return this.weighted(f, u);
  }

  private weighted(f: Fleet, u: number): TownBuilding {
    const x = u * f.cum[f.cum.length - 1];
    let lo = 0;
    let hi = f.cum.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (f.cum[m] > x) hi = m;
      else lo = m + 1;
    }
    return f.homes[lo];
  }

  /** Место занято чужим манёвром (своё, соседнее; гараж — пока машина перед воротами дома). */
  private blocked(town: Town, car: FleetCar): boolean {
    const p = car.place!;
    // Место на полосе стоянки: там манёвр или к нему кто-то едет.
    if (p.curb) return !this.curb || this.curb.isTaken(p.curb.key);
    if (this.garages.isBusy(p.spot.key) || p.near.some((k) => this.garages.isBusy(k))) return true;
    if (p.kind !== 'garage') return false;
    const apron = carKey(car.home.id, 1);
    return this.fleet(town).byKey.has(apron) && this.isHome(town, apron);
  }

  /** Можно ли сейчас машине со своего места в поток: дома, место не занято, к полосе у него можно подъехать. */
  private canLeave(town: Town, car: FleetCar): boolean {
    return !!car.place && this.isHome(town, car.key) && !this.blocked(town, car) && this.reachable(car.place);
  }

  /** К месту можно подъехать (и выехать от него): к заезду — slotOf, к месту на полосе стоянки — её полоса движения. */
  private reachable(p: Place, left = false): boolean {
    if (p.curb) return !!this.curb?.slotOf(p.curb);
    return !!this.garages.slotOf(p.spot) || (left && !!this.garages.leftSlotOf(p.spot));
  }

  /** Отстоявшие у цели и не в пути — кто может ехать домой (на стоянке магазина — нет: уедет сама, по сроку). */
  private readyCars(a: Away): TownCar[] {
    const parked = new Set<number>();
    for (const t of this.host.towns) for (const c of t.shopParked ?? []) if (c.car !== undefined) parked.add(c.car);
    a.ready = a.ready.filter((e) => a.byCar.get(e.car) === e);
    const out: TownCar[] = [];
    for (const e of a.ready) {
      if (this.moving.has(e.car)) continue;
      // Стояла на стоянке магазина, а её там больше нет (снесли, увезла к случайному дому) — просто у цели.
      if (e.spot !== undefined && !parked.has(e.car)) delete e.spot;
      if (e.spot === undefined) out.push(e);
    }
    return out;
  }

  /**
   * Поездка жителя из дома origin города town: возвращение машины, отстоявшей у цели, или выезд машины дома origin
   * (её нет — другого дома города, по весу). Машины без места и машин дома нет — null: поездка от узла до узла. Номер
   * поездки — Town.carTrips, решение — по хешу от него и seed партии.
   */
  trip(town: Town, origin: TownBuilding): FleetTrip | null {
    const n = (town.carTrips = (town.carTrips ?? 0) + 1);
    const seed = tripSeed(this.host.seed, town.id, n);
    const r = (k: number) => hash(seed, k);
    const f = this.fleet(town);
    if (!f.placed) return null;
    const a = this.away(town);
    const ready = this.readyCars(a);
    // Возвращение машины e (отстояла у цели), если к её месту можно подъехать; нет — вернулась незаметно.
    const back = (e: TownCar): FleetTrip | null => {
      const car = f.byKey.get(e.car);
      if (car?.place && !this.blocked(town, car) && this.reachable(car.place, true)) {
        // Стоит у цели на полосе стоянки — уедет с места (выехать нельзя — подождёт другой поездки).
        const st = e.curb !== undefined ? this.curb?.stall(e.curb) : undefined;
        if (st && !this.curb!.canLeave(st)) return null;
        return { kind: 'back', car, town, from: e.at !== undefined ? this.building(e.at) : null, ...(st ? { curb: st } : {}) };
      }
      // Машины больше нет (дом снесли) или к её месту не подъехать — вернулась незаметно.
      if (!car?.place || !this.reachable(car.place)) this.settle(town, e.car);
      return null;
    };
    if (ready.length && r(1) < ready.length / (ready.length + CAR_HOMES.backK * f.placed)) {
      const t = back(ready[Math.floor(r(2) * ready.length)]);
      if (t) return t;
    }
    // Выезд: машина дома — какая из машин дома, по хешу; без места — поездка от узла.
    const pick = (b: TownBuilding, k: number): FleetCar | 'none' | null => {
      const list = f.byHome.get(b.id);
      if (!list?.length) return null;
      const first = list[Math.floor(r(k) * list.length)];
      if (!first.place) return 'none';
      if (this.canLeave(town, first)) return first;
      return list.find((c) => this.canLeave(town, c)) ?? null;
    };
    let c = pick(origin, 3);
    if (c === 'none') return null;
    if (!c) {
      // Машины дома нет — в разъездах: отстояла у цели — едет домой (поездка жителя дома — за ней).
      const own = new Set((f.byHome.get(origin.id) ?? []).map((x) => x.key));
      const mine = ready.filter((e) => own.has(e.car));
      const t = mine.length ? back(mine[Math.floor(r(4) * mine.length)]) : null;
      if (t) return t;
    }
    for (let i = 0; !c && i < CAR_HOMES.tries; i++) {
      const x = pick(this.weighted(f, r(10 + i)), 20 + i);
      if (x !== 'none') c = x;
    }
    return c ? { kind: 'out', car: c, town } : null;
  }

  /** Дом по id — в любом городе. */
  private building(id: number): TownBuilding | null {
    for (const t of this.host.towns) {
      const b = this.fleet(t).byId.get(id);
      if (b) return b;
    }
    return null;
  }

  /** Машина парка по ключу и её город. */
  carOf(key: number): { town: Town; car: FleetCar } | null {
    const home = carHomeOf(key);
    for (const town of this.host.towns) {
      const f = this.fleet(town);
      if (!f.byId.has(home)) continue;
      const car = f.byKey.get(key);
      return car ? { town, car } : null;
    }
    return null;
  }

  /**
   * Машина выезжает со своего места к дому dest (TownCar.at): задним ходом к бордюру, ждёт просвета, встаёт в поток
   * (Garages.leave). opt — к стоянке магазина (target, endLink, to, then — как у Garages.leave), иначе — к узлу dest.
   * stay — сколько простоит у цели (u — хеш поездки).
   */
  depart(trip: Extract<FleetTrip, { kind: 'out' }>, dest: TownBuilding, opt: { target?: number; endLink?: number; to?: CarSpot; then?: (sim: Vehicle) => void } = {}): void {
    const { car, town } = trip;
    const n = town.carTrips ?? 0;
    const stay = stayAt(dest, hash(tripSeed(this.host.seed, town.id, n), 5));
    this.moving.add(car.key);
    const hooks: MoveHooks = {
      joined: (sim) => {
        this.goAway(town, { car: car.key, at: dest.id, until: this.host.time + stay });
        this.driving.set(sim.id, { car: car.key, town, home: false });
      },
      stayed: () => this.moving.delete(car.key),
    };
    const { target, ...rest } = opt;
    const st = car.place!.curb;
    // Место ночёвки на полосе стоянки — выезд передом от бордюра (CurbParking.leave).
    const curbHooks: CurbHooks = { joined: hooks.joined, stayed: hooks.stayed };
    if (st && this.curb) this.curb.leave(st, target ?? dest.anchor, { from: car.home, to: dest }, { color: car.color, hooks: curbHooks, endLink: opt.endLink, then: opt.then });
    else this.garages.leave(car.place!.spot, town, target ?? dest.anchor, { from: car.home, to: dest }, { color: car.color, hooks, ...rest });
  }

  /**
   * Места у цели на полосах стоянки (её улица и соседние, CurbParking.visitTarget): к какой связи ехать и из чего выбрать.
   * Полос стоянки рядом нет или все места заняты — null (поездка кончится у узла цели).
   */
  curbVisit(dest: TownBuilding, from?: number): { link: GLink; choices: () => CurbStall[] } | null {
    return this.curb?.visitTarget(dest.fp.center, from) ?? null;
  }

  /**
   * Машина парка в потоке (выехала к цели trip.car) встаёт на полосу стоянки у цели: место — ближнее свободное на
   * подъезде (CurbParking.toCurb); встала — TownCar.curb. Мест не осталось — едет к узлу цели, как раньше.
   */
  toCurbVisit(sim: Vehicle, trip: Extract<FleetTrip, { kind: 'out' }>, v: { link: GLink; choices: () => CurbStall[] }): void {
    const { car, town } = trip;
    const curb = this.curb;
    if (!curb) return;
    this.curbIn.add(car.key);
    curb.toCurb(sim, v.link.id, v.choices, {
      arrived: (st) => {
        this.curbIn.delete(car.key);
        this.moving.delete(car.key);
        const e = this.away(town).byCar.get(car.key);
        if (!e) return;
        e.curb = st.key;
        e.cp = [Math.round(st.pos.x * 10) / 10, Math.round(st.pos.y * 10) / 10];
        curb.park(st.key, car.key);
      },
      missed: () => this.curbIn.delete(car.key),
    });
  }

  /**
   * Путь машины парка домой от узла from: к заезду её места (Garages.wayHome — направо или налево) или к месту на полосе
   * стоянки (CurbParking.wayTo). Не доехать — null.
   */
  homeWay(from: number, car: FleetCar): { route: number[]; toNode: number; slot?: GarageSlot } | null {
    const p = car.place;
    if (!p) return null;
    if (p.curb) {
      const w = this.curb?.wayTo(from, p.curb);
      return w ? { route: w.route, toNode: w.link.toNode! } : null;
    }
    const w = this.garages.wayHome(from, p.spot);
    return w ? { route: w.route, toNode: w.slot.link.toNode!, slot: w.slot } : null;
  }

  /**
   * Возвращение машины, что стоит у цели на полосе стоянки (trip.curb): выезжает с места к своему месту ночёвки — к
   * связи у его заезда (направо или налево) или у места на полосе стоянки. Не подъехать — false.
   */
  leaveCurb(trip: Extract<FleetTrip, { kind: 'back' }>): boolean {
    const { car, town, curb: st } = trip;
    const curb = this.curb;
    const p = car.place;
    if (!curb || !st || !p) return false;
    const home = p.curb ? curb.slotOf(p.curb) : null;
    const slot = p.curb ? null : (this.garages.slotOf(p.spot) ?? this.garages.leftSlotOf(p.spot));
    const link = home?.link ?? slot?.link;
    if (!link) return false;
    this.moving.add(car.key);
    const from = trip.from ?? car.home;
    curb.leave(st, link.toNode!, { from, to: p.at }, {
      color: car.color,
      endLink: link.id,
      hooks: {
        joined: (sim) => {
          const e = this.away(town).byCar.get(car.key);
          if (e?.curb !== undefined) {
            curb.unpark(e.curb, car.key);
            delete e.curb;
            delete e.cp;
          }
          this.driving.set(sim.id, { car: car.key, town, home: true });
        },
        stayed: () => this.moving.delete(car.key),
      },
      then: (sim) => this.homeward(sim, trip, slot ?? undefined),
    });
    return true;
  }

  /** Машина парка едет на стоянку магазина (ShopParking.start): встала на место — отмечена там (TownCar.spot). */
  visit(car: FleetCar, town: Town): FleetVisit {
    return {
      car: car.key,
      parked: (spot) => {
        const e = this.away(town).byCar.get(car.key);
        if (e) e.spot = spot;
      },
    };
  }

  /** Крючки манёвра машины, что едет на своё место: доехала — дома. */
  private homeHooks(town: Town, car: FleetCar): MoveHooks {
    return { arrived: () => this.settle(town, car.key) };
  }

  /** Какое место выбрать на полосе у своего (Garages.toStall): только своё, если не занято. */
  private choices(town: Town, car: FleetCar): () => CarSpot[] {
    return () => (this.blocked(town, car) ? [] : [car.place!.spot]);
  }

  /**
   * Машина в потоке sim везёт машину парка на её место: маршрут — к связи у места (Garages.wayHome), slot — поворот к
   * нему (направо или налево). Не успеет свернуть — поездка кончится у узла, машина «вернётся незаметно».
   */
  homeward(sim: Vehicle, trip: Extract<FleetTrip, { kind: 'back' }>, slot?: GarageSlot): void {
    const { car, town } = trip;
    this.moving.add(car.key);
    this.driving.set(sim.id, { car: car.key, town, home: true });
    const st = car.place!.curb;
    if (st && this.curb) {
      // Своё место на полосе стоянки: на полосе у него — только оно, если не занято.
      const link = this.curb.slotOf(st)?.link.id;
      if (link === undefined) return;
      const curb = this.curb;
      curb.toCurb(sim, link, () => (curb.isTaken(st.key) ? [] : [st]), { arrived: () => this.settle(town, car.key) });
      return;
    }
    const s = slot ?? this.garages.slotOf(car.place!.spot) ?? this.garages.leftSlotOf(car.place!.spot);
    if (s) this.garages.toStall(sim, car.place!.spot, town, s, this.homeHooks(town, car), this.choices(town, car));
  }

  /**
   * Машина парка уезжает со стоянки магазина на своё место (ShopHost.backHome): к какому месту и как свернуть к нему.
   * Нет своего места, не подъехать или место занято — null.
   */
  backHome(sc: ShopCar): FleetBack | null {
    const hit = sc.car !== undefined ? this.carOf(sc.car) : null;
    if (!hit?.car.place || this.moving.has(hit.car.key)) return null;
    const { town, car } = hit;
    const spot = car.place!.spot;
    const st = car.place!.curb;
    if (st) {
      // Место ночёвки на полосе стоянки: со стоянки магазина — к связи у него, там встанет на место (homeward).
      const cs = this.curb?.slotOf(st);
      if (!cs || this.blocked(town, car)) return null;
      const g = this.curb!;
      const pose = { pos: st.pos, f: st.dir };
      const slot: GarageSlot = { lane: cs.lane, link: cs.link, mid: cs.u, zone: [cs.u - 5, cs.u + 5], ...pose };
      return {
        home: car.place!.at,
        to: spot,
        slot,
        joined: (sim) => {
          const e = this.away(town).byCar.get(car.key);
          if (e) delete e.spot;
          this.moving.add(car.key);
          this.driving.set(sim.id, { car: car.key, town, home: true });
        },
        then: (sim) => {
          if (g.slotOf(st)) this.homeward(sim, { kind: 'back', car, town, from: null });
        },
      };
    }
    const slot = this.garages.slotOf(spot) ?? this.garages.leftSlotOf(spot);
    if (!slot || this.blocked(town, car)) return null;
    return {
      home: car.place!.at,
      to: spot,
      slot,
      joined: (sim) => {
        const e = this.away(town).byCar.get(car.key);
        if (e) delete e.spot;
        this.moving.add(car.key);
        this.driving.set(sim.id, { car: car.key, town, home: true });
      },
      then: (sim) => this.garages.toStall(sim, spot, town, this.garages.slotOf(spot) ?? slot, this.homeHooks(town, car), this.choices(town, car)),
    };
  }

  /**
   * Машина в потоке кончила поездку у узла (доехала до цели или потерялась): ехала к цели — стоит у неё; ехала на своё
   * место и не свернула к нему — вернулась незаметно.
   */
  arrived(simId: number): void {
    const d = this.driving.get(simId);
    if (!d) return;
    this.driving.delete(simId);
    this.curbIn.delete(d.car);
    if (d.home) this.settle(d.town, d.car);
    else this.moving.delete(d.car);
  }

  /** Машина в потоке свернула на место (Garages: ушла с полосы): к цели — стоит на стоянке; домой — доедет по двору. */
  gone(simId: number): void {
    const d = this.driving.get(simId);
    if (!d) return;
    this.driving.delete(simId);
    // Встаёт на полосу стоянки у цели — у цели, когда встанет на место (toCurbVisit).
    if (!d.home && !this.curbIn.has(d.car)) this.moving.delete(d.car);
  }

  /** Машина парка, что едет в потоке (id машины в потоке) — ключ и едет ли на своё место. */
  carOfSim(simId: number): { car: number; home: boolean } | undefined {
    const d = this.driving.get(simId);
    return d && { car: d.car, home: d.home };
  }

  /**
   * Машины дома на виду в кадре — вблизи (как у гаражей, FINE_ZOOM): на площадке, перед воротами, во дворе, на местах
   * у улицы. В гараже и в боксе их не видно; уехавших и тех, что на манёвре, нет (манёвр рисует Garages).
   */
  looks(box: [number, number, number, number]): GarageLook[] {
    const out: GarageLook[] = [];
    const spec = this.host.car;
    const pad = 12;
    for (const town of this.host.towns) {
      const f = this.fleet(town);
      const b = f.box;
      if (!f.placed || b[2] < box[0] - pad || b[0] > box[2] + pad || b[3] < box[1] - pad || b[1] > box[3] + pad) continue;
      const a = this.away(town);
      for (const c of f.cars) {
        const look = c.place?.look;
        if (!look || this.moving.has(c.key) || a.byCar.has(c.key)) continue;
        const p = look.pos;
        if (p.x < box[0] - pad || p.x > box[2] + pad || p.y < box[1] - pad || p.y > box[3] + pad) continue;
        out.push({ look: { ...spec, color: c.color, pos: p, dir: look.dir } });
      }
    }
    // Машины у целей на полосах стоянки (TownCar.curb), кроме тех, что уже выезжают.
    const curb = this.curb;
    if (curb) {
      for (const town of this.host.towns) {
        const f = this.fleet(town);
        for (const e of town.cars ?? []) {
          if (e.curb === undefined || this.moving.has(e.car)) continue;
          const st = curb.stall(e.curb);
          const c = st && f.byKey.get(e.car);
          if (!st || !c || curb.moving(st.key)) continue;
          const p = add(st.pos, scale(st.dir, spec.length / 2));
          if (p.x < box[0] - pad || p.x > box[2] + pad || p.y < box[1] - pad || p.y > box[3] + pad) continue;
          out.push({ look: { ...spec, color: c.color, pos: p, dir: st.dir } });
        }
      }
    }
    return out;
  }

  /**
   * Занятость мест ночёвки — дворов и боксов (слой 🅿️): по каждому дому с местами — где (середина участка), сколько
   * мест и сколько занято (машина дома). Места без машины — свободны.
   */
  occupancy(): { pos: Vec; total: number; used: number }[] {
    const out = new Map<number, { pos: Vec; total: number; used: number }>();
    for (const town of this.host.towns) {
      const f = this.fleet(town);
      for (const x of f.lots) out.set(x.b.id, { pos: x.b.fp.center, total: x.total, used: 0 });
      for (const c of f.cars) {
        const p = c.place;
        if (!p || (p.kind !== 'stall' && p.kind !== 'yard' && p.kind !== 'box')) continue;
        const cell = out.get(p.at.id);
        if (cell && this.isHome(town, c.key)) cell.used++;
      }
    }
    return [...out.values()];
  }
}

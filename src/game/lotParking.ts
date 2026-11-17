import { dist, type Vec } from '../core/vec';
import type { GLink, LaneGraph } from '../lanes/graph';
import { findLaneRoute } from '../lanes/routing';
import type { LaneTraffic } from '../lanes/traffic';
import type { Vehicle, VehicleSpec } from '../sim/vehicle';
import type { LotStats, ParkingLot, Town, TownBuilding, TownCar } from '../world/entities';
import { gateIn, gateOut, LOT, lotGateDriveway, lotIsBig, lotLayout, lotRoute, type LotLayout } from '../world/parkingLots';
import { carSpot, type CarSpot } from './garages';
import { stallKey } from './shopParking';
import type { Driveway } from '../world/houseAccess';
import { dockDriveway } from '../world/shopLots';
import { yardLotOf, yardSpots } from '../world/yardLots';

/**
 * Площадки-стоянки в игре (docs/PARKING.md, этап 3; раскладка — world/parkingLots.ts): кто где стоит, ворота, заезд и
 * выезд, счёт за месяц. Маленькая площадка (до LOT.big мест) — въезд — место манёвра у Garages (CarSpot, open — ворот на
 * деле нет): с полосы через тротуар и дальше по проездам до места, на виду (route; место — за машиной, когда она
 * сворачивает к въезду, hold), выезд — тем же путём задним ходом до бордюра; одна машина во въезде за раз. Большая — ворота
 * примкнуты к дорогам тупиком-выездом (ParkingLot.nodes): машина едет к узлу ворот через перекрёсток (очереди и повороты —
 * логика узлов), у узла встаёт на место; выезжает — встаёт в поток у узла.
 *
 * Кто где стоит — данные: гости у цели — Town.cars (TownCar.lot, ls), места ночёвки — у CarHomes (по геометрии); тут —
 * кто занял, кто едет к площадке, и выезды с большой площадки, без генератора случайных чисел партии.
 */
export const LOT_TRIPS = {
  /** Места ночёвки берут не больше этой доли мест площадки: остальные — гостям. */
  homeShare: 0.5,
  /** Место ночёвки на площадке — не дальше стольких ед. от дома (≈ 200 м). */
  homeRange: 330,
  /** Выезд с большой площадки: места в потоке у узла нет — ждёт не дольше стольких с. */
  maxWait: 40,
  /** Свой двор цели — сколько машин работников и гостей в нём встаёт (за воротами их не видно). */
  yardCap: { garages: 6, warehouse: 5, depot: 6 },
};

/** Что площадкам нужно от игры. */
export interface LotHost {
  readonly time: number;
  readonly towns: readonly Town[];
  readonly traffic: LaneTraffic;
  readonly graph: LaneGraph;
  readonly car: Omit<VehicleSpec, 'color'>;
  /** Номер правки площадок (поставили, перенесли, ворота, снос, отмена, загрузка) — сменился: всё заново. */
  rev(): number;
  /** Машина с большой площадки встала в поток (как GarageHost.own). */
  own(sim: Vehicle, trip: { from: TownBuilding; to: TownBuilding }): void;
  /** Во дворе дома грузовик на манёвре (game/docks.ts): машинам ждать. */
  yardBusy?(b: number): boolean;
}

/** Что делать на вехах: встала на место (номер), не нашла места, встала в поток, не выехала. */
export interface LotHooks {
  arrived?(stall: number): void;
  missed?(): void;
  joined?(sim: Vehicle): void;
  stayed?(): void;
}

/** Ссылка на площадку: она и её город. */
export interface LotRef {
  lot: ParkingLot;
  town: Town;
}

/** Выезд с большой площадки: ждёт места в потоке у узла ворот. */
interface Exit {
  lot: ParkingLot;
  node: number;
  target: number;
  endLink?: number;
  color: string;
  trip: { from: TownBuilding; to: TownBuilding };
  hooks: LotHooks;
  then?: (sim: Vehicle) => void;
  wait: number;
}

/** Чей это ключ места манёвра (ворота площадки): номер площадки × 64 + 40 + номер ворот. */
const GATE_KEY = 40;

/** Псевдодом площадки для места манёвра (CarSpot.b): Garages читает только id. */
function lotBuilding(lot: ParkingLot): TownBuilding {
  return { id: lot.id, fp: lot.fp } as TownBuilding;
}

export class LotParking {
  private seen = -1;
  private list: LotRef[] = [];
  private byId = new Map<number, LotRef>();
  private spots = new Map<number, (CarSpot | null)[]>();
  /** Растёт, когда меняются площадки: парк машин назначает места ночёвки заново. */
  version = 0;
  /** Гости у цели: площадка → место → ключ машины. */
  private parked = new Map<number, Map<number, number>>();
  /** Места ночёвки машин парка: площадка → место → ключ машины (по городу — кто назначил). */
  private homes = new Map<number, Map<number, number>>();
  private homesOf = new Map<number, { lot: number; stall: number; car: number }[]>();
  /** Машины в потоке, что едут на площадку: id машины → площадка (занимают место в счёте свободных). */
  private incoming = new Map<number, number>();
  /**
   * Место за машиной, что уже сворачивает к воротам и едет к нему по проездам (hold): другим не достаётся, но ещё не
   * занято (в счёте и сохранении — с park, когда встала).
   */
  private held = new Map<number, Map<number, number>>();
  /** Едут к узлу ворот большой площадки: id машины → площадка и крючки. */
  private bigHoming = new Map<number, { lot: number; hooks: LotHooks }>();
  readonly exits: Exit[] = [];
  /** Дома ли машина (CarHomes): тогда на её месте ночёвки стоит машина. */
  homeAt: (car: number) => boolean = () => false;

  constructor(private host: LotHost) {}

  /** Площадки всех городов (не снесённые). */
  all(): readonly LotRef[] {
    this.sync();
    return this.list;
  }

  get(id: number): LotRef | undefined {
    this.sync();
    return this.byId.get(id);
  }

  private sync(): void {
    const rev = this.host.rev();
    if (rev === this.seen) return;
    this.seen = rev;
    this.list = [];
    this.byId.clear();
    this.spots.clear();
    for (const town of this.host.towns) {
      for (const lot of town.lots ?? []) {
        if (lot.removed) continue;
        const ref = { lot, town };
        this.list.push(ref);
        this.byId.set(lot.id, ref);
      }
    }
    // Гости, чьей площадки (или места) больше нет, — «в разъездах»; прочие — на своих местах.
    this.parked.clear();
    this.yards.clear();
    for (const town of this.host.towns) {
      for (const e of town.cars ?? []) {
        if (e.yard !== undefined) this.yardPark(e.yard, e.car);
        if (e.lot === undefined) continue;
        const ref = this.byId.get(e.lot);
        const n = ref ? lotLayout(ref.lot).stalls.length : 0;
        const at = this.parked.get(e.lot);
        if (!ref || e.ls === undefined || e.ls >= n || at?.has(e.ls)) {
          delete e.lot;
          delete e.ls;
          continue;
        }
        this.mapOf(this.parked, e.lot).set(e.ls, e.car);
      }
    }
    this.version++;
  }

  private mapOf(m: Map<number, Map<number, number>>, id: number): Map<number, number> {
    let x = m.get(id);
    if (!x) m.set(id, (x = new Map()));
    return x;
  }

  /** Площадки не дальше r от точки (по середине участка). */
  near(p: Vec, r: number): LotRef[] {
    return this.all().filter((x) => dist(x.lot.fp.center, p) <= r + x.lot.fp.w / 2);
  }

  layout(lot: ParkingLot): LotLayout {
    return lotLayout(lot);
  }

  /** Ворота через узел графа (большая площадка). */
  big(lot: ParkingLot): boolean {
    return lotIsBig(lot) && !!lot.nodes?.length;
  }

  // ---------- Ворота ----------

  /** Места манёвра у ворот маленькой площадки (по номеру ворот). */
  gateSpots(lot: ParkingLot): (CarSpot | null)[] {
    this.sync();
    let s = this.spots.get(lot.id);
    if (s) return s;
    const L = this.host.car.length;
    // Ворот на деле нет — открытый въезд: машина на манёвре видна всё время (CarSpot.open).
    s = lot.gates.map((g, i) => ({ ...carSpot(stallKey(lot.id, GATE_KEY + i), lotBuilding(lot), lotGateDriveway(lot, g), false, '#888888', L), open: true }));
    this.spots.set(lot.id, s);
    return s;
  }

  /**
   * Путь середины кузова по маленькой площадке: от бордюра у ворот spot (CarSpot.curbSide — его Garages ставит первой
   * точкой) по проездам до места stall (world/parkingLots.lotRoute); въезд — по нему передом, выезд — тем же путём
   * задним ходом. Нет такого — null.
   */
  route(spot: CarSpot, stall: number): Vec[] | null {
    const lot = this.lotOfSpot(spot.key);
    const gate = lot?.gates[-spot.key - 1 - lot.id * 64 - GATE_KEY];
    if (!lot || !gate || !lotLayout(lot).stalls[stall]) return null;
    return lotRoute(lot, gate.x, stall, this.host.car.length);
  }

  /** Ворота маленькой площадки, куда можно въехать (или выехать): по порядку — сперва в обе стороны. */
  spotFor(lot: ParkingLot, out: boolean): CarSpot[] {
    const spots = this.gateSpots(lot);
    return lot.gates
      .map((g, i) => ({ g, s: spots[i] }))
      .filter((x) => !!x.s && (out ? gateOut(x.g.mode) : gateIn(x.g.mode)))
      .sort((a, b) => (a.g.mode === 'both' ? 0 : 1) - (b.g.mode === 'both' ? 0 : 1))
      .map((x) => x.s!);
  }

  /** Узлы ворот большой площадки, куда можно въехать (или откуда выехать). */
  nodesFor(lot: ParkingLot, out: boolean): number[] {
    return lot.gates.flatMap((x, i) => {
      const n = lot.nodes?.[i];
      return n !== undefined && n >= 0 && (out ? gateOut(x.mode) : gateIn(x.mode)) ? [n] : [];
    });
  }

  /** Площадка, чьи ворота — это место манёвра (ключ). */
  lotOfSpot(key: number): ParkingLot | undefined {
    const id = Math.floor((-key - 1) / 64);
    return this.get(id)?.lot;
  }

  // ---------- Кто где стоит ----------

  /** Места ночёвки машин парка города (CarHomes.build): площадка → место → ключ машины. */
  setHomes(town: number, list: { lot: number; stall: number; car: number }[]): void {
    this.homesOf.set(town, list);
    this.homes.clear();
    for (const l of this.homesOf.values()) for (const x of l) this.mapOf(this.homes, x.lot).set(x.stall, x.car);
  }

  /** Место — место ночёвки машины другого города (не town). */
  homeElsewhere(lot: number, stall: number, town: number): boolean {
    for (const [t, list] of this.homesOf) if (t !== town && list.some((x) => x.lot === lot && x.stall === stall)) return true;
    return false;
  }

  /** Мест ночёвки на площадке у машин других городов (не town). */
  homesElsewhere(lot: number, town: number): number {
    let n = 0;
    for (const [t, list] of this.homesOf) if (t !== town) for (const x of list) if (x.lot === lot) n++;
    return n;
  }

  /** Место — чьё-то место ночёвки. */
  isHome(lot: number, stall: number): boolean {
    return this.homes.get(lot)?.has(stall) ?? false;
  }

  /** Мест ночёвки уже назначено на площадке. */
  homesUsed(lot: number): number {
    return this.homes.get(lot)?.size ?? 0;
  }

  /** Место занято: стоит гость или хозяин дома. */
  occupied(lot: number, stall: number): boolean {
    this.sync();
    if (this.parked.get(lot)?.has(stall)) return true;
    const car = this.homes.get(lot)?.get(stall);
    return car !== undefined && this.homeAt(car);
  }

  /** Свободно для гостя: не чьё-то место ночёвки и никто не стоит. */
  freeStall(lot: number, stall: number): boolean {
    this.sync();
    return !this.isHome(lot, stall) && !this.parked.get(lot)?.has(stall) && !this.held.get(lot)?.has(stall);
  }

  /** Сколько мест свободно для гостей — за вычетом тех, кто уже едет сюда. */
  free(lot: ParkingLot): number {
    const n = lotLayout(lot).stalls.length;
    let free = 0;
    for (let i = 0; i < n; i++) if (this.freeStall(lot.id, i)) free++;
    for (const id of this.incoming.values()) if (id === lot.id) free--;
    return free;
  }

  /** Гостевых мест на площадке (не ночёвка). */
  guestStalls(lot: ParkingLot): number {
    return lotLayout(lot).stalls.length - this.homesUsed(lot.id);
  }

  /** Ближнее к точке p свободное для гостя место; нет — −1. */
  pick(lot: ParkingLot, p: Vec): number {
    const stalls = lotLayout(lot).stalls;
    let best = -1;
    for (let i = 0; i < stalls.length; i++) {
      if (!this.freeStall(lot.id, i)) continue;
      if (best < 0 || dist(stalls[i].pos, p) < dist(stalls[best].pos, p)) best = i;
    }
    return best;
  }

  /** Гость car встал на место stall (TownCar.lot, ls). */
  park(lot: number, stall: number, car: number): void {
    this.release(lot, stall, car);
    this.mapOf(this.parked, lot).set(stall, car);
  }

  /** Место stall — за машиной car, что едет к нему по проездам (свернула к воротам): другим не достанется. */
  hold(lot: number, stall: number, car: number): void {
    this.mapOf(this.held, lot).set(stall, car);
  }

  /** Снять hold (встала — park, не доехала — сама). */
  release(lot: number, stall: number, car: number): void {
    const m = this.held.get(lot);
    if (m?.get(stall) === car) m.delete(stall);
  }

  unpark(lot: number, stall: number, car?: number): void {
    const m = this.parked.get(lot);
    if (m && (car === undefined || m.get(stall) === car)) m.delete(stall);
  }

  /** Машина в потоке едет на площадку (место в счёте свободных — за ней) или уже нет. */
  expect(simId: number, lot: number | null): void {
    if (lot === null) this.incoming.delete(simId);
    else this.incoming.set(simId, lot);
  }

  /** Кто стоит у целей — заново (после загрузки). */
  clear(): void {
    this.parked.clear();
    this.held.clear();
    this.incoming.clear();
    this.incomingYard.clear();
    this.yardSpots.clear();
    this.bigHoming.clear();
    this.exits.length = 0;
    this.seen = -1;
  }

  /** Гость у цели e стоит на площадке: где (нос, курс). */
  poseOf(e: TownCar): { nose: Vec; dir: Vec } | null {
    if (e.lot === undefined || e.ls === undefined) return null;
    const ref = this.get(e.lot);
    const st = ref && lotLayout(ref.lot).stalls[e.ls];
    return st ? { nose: st.nose, dir: st.dir } : null;
  }

  // ---------- Большая площадка: через узел ----------

  /** Путь к узлу ворот большой площадки со связей starts. Не доехать — null. */
  wayToBig(lot: ParkingLot, starts: GLink[]): { route: number[]; node: number } | null {
    const g = this.host.graph;
    let best: { route: number[]; node: number; n: number } | null = null;
    for (const node of this.nodesFor(lot, false)) {
      const route = findLaneRoute(g, starts, node);
      if (route && (!best || route.length < best.n)) best = { route, node, n: route.length };
    }
    return best && { route: best.route, node: best.node };
  }

  /** Машина в потоке едет к узлу ворот большой площадки: доедет — встанет на место (arrive). */
  toBig(sim: Vehicle, lot: ParkingLot, hooks: LotHooks): void {
    delete sim.endLink;
    delete sim.endLeft;
    this.bigHoming.set(sim.id, { lot: lot.id, hooks });
    this.expect(sim.id, lot.id);
  }

  /** Едет ли машина к узлу ворот большой площадки. */
  isHomingBig(simId: number): boolean {
    return this.bigHoming.has(simId);
  }

  /**
   * Машина доехала до узла (Game.onArrive): ехала к воротам большой площадки и это её узел — встаёт на ближнее
   * свободное место (крючок arrived) или мест нет (missed — решает, что дальше; машина уже снята с потока). Не её — false.
   */
  arrive(sim: Vehicle): boolean {
    const h = this.bigHoming.get(sim.id);
    if (!h) return false;
    this.bigHoming.delete(sim.id);
    this.incoming.delete(sim.id);
    const ref = this.get(h.lot);
    if (!ref || !ref.lot.nodes?.includes(sim.targetNode)) {
      h.hooks.missed?.();
      return false;
    }
    const k = this.pick(ref.lot, sim.pos);
    if (k < 0) {
      // Заняли, пока ехала: поездка кончилась у узла ворот, как у всех.
      h.hooks.missed?.();
      return false;
    }
    h.hooks.arrived?.(k);
    return true;
  }

  /** Машина в потоке кончила поездку или потерялась: площадку она больше не ждёт. */
  forget(simId: number, quiet = false): void {
    this.incoming.delete(simId);
    const h = this.bigHoming.get(simId);
    if (!h) return;
    this.bigHoming.delete(simId);
    if (!quiet) h.hooks.missed?.();
  }

  /** Выезд с большой площадки к узлу target: ждёт места в потоке у узла ворот (с выездом). */
  leaveBig(lot: ParkingLot, target: number, trip: { from: TownBuilding; to: TownBuilding }, opt: { color: string; hooks?: LotHooks; endLink?: number; then?: (sim: Vehicle) => void }): boolean {
    const node = this.nodesFor(lot, true)[0];
    if (node === undefined) return false;
    this.exits.push({ lot, node, target, endLink: opt.endLink, color: opt.color, trip, hooks: opt.hooks ?? {}, then: opt.then, wait: 0 });
    return true;
  }

  /** Такт: выезды с больших площадок. */
  step(dt: number): void {
    const traffic = this.host.traffic;
    const g = this.host.graph;
    for (let i = 0; i < this.exits.length; i++) {
      const x = this.exits[i];
      x.wait += dt;
      const route = findLaneRoute(g, g.outLinks.get(x.node) ?? [], x.target, x.endLink);
      const sim = route ? traffic.spawn({ ...this.host.car, color: x.color, targetNode: x.target, route }) : null;
      if (!sim) {
        if (route && x.wait < LOT_TRIPS.maxWait) continue;
        x.hooks.stayed?.();
        this.exits.splice(i--, 1);
        continue;
      }
      if (x.endLink !== undefined) sim.endLink = x.endLink;
      this.host.own(sim, x.trip);
      x.hooks.joined?.(sim);
      x.then?.(sim);
      this.exits.splice(i--, 1);
    }
  }

  // ---------- Счёт ----------

  /** Машина встала на площадку: счёт месяца (кто — 0 🏠, 1 🛒, 2 🏭, 3 🚉). */
  noteCar(lot: ParkingLot, who: 0 | 1 | 2 | 3): void {
    const m = (lot.month ??= emptyStats());
    m.cars++;
    m.who[who]++;
  }

  /** Машина уехала с площадки, простояв stay с. */
  noteLeft(lot: ParkingLot, stay: number): void {
    const m = (lot.month ??= emptyStats());
    m.left++;
    m.stay += Math.max(0, Math.round(stay));
  }

  // ---------- Свой двор цели (склад, оптовая база, гаражи) ----------

  /** Свой двор цели: место манёвра у его ворот (въезд — как во двор, за воротами машин не видно). Нет — null. */
  yardSpot(b: TownBuilding): CarSpot | null {
    let s = this.yardSpots.get(b.id);
    if (s !== undefined && s?.b === b) return s;
    const L = this.host.car.length;
    const form = b.form;
    let d: Driveway | null = null;
    if (form === 'garages') {
      const lot = yardLotOf(b);
      d = lot ? yardSpots(b, lot, L).gate : null;
    } else if (form && form in LOT_TRIPS.yardCap) {
      const dd = dockDriveway(b);
      d = dd && { ...dd, garage: true };
    }
    // Ворота гаражей — те же, что у боксов (CarHomes): одна машина в воротах за раз.
    s = d ? carSpot(stallKey(b.id, form === 'garages' ? 63 : 61), b, d, false, '#888888', L) : null;
    this.yardSpots.set(b.id, s);
    return s;
  }

  private yardSpots = new Map<number, CarSpot | null>();

  /** Сколько машин может стоять во дворе цели (0 — своего двора нет). */
  yardCap(b: TownBuilding): number {
    return (LOT_TRIPS.yardCap as Record<string, number>)[b.form ?? ''] ?? 0;
  }

  /** Во дворе цели есть место: машин меньше вместимости, двор не занят грузовиком. */
  yardFree(b: TownBuilding): boolean {
    return (this.yards.get(b.id)?.size ?? 0) + this.yardIncoming(b.id) < this.yardCap(b) && !this.host.yardBusy?.(b.id);
  }

  private yardIncoming(b: number): number {
    let n = 0;
    for (const id of this.incomingYard.values()) if (id === b) n++;
    return n;
  }

  private yards = new Map<number, Set<number>>();
  private incomingYard = new Map<number, number>();

  /** Сколько машин стоит во дворе цели. */
  yardCount(b: number): number {
    return this.yards.get(b)?.size ?? 0;
  }

  /** Машина едет во двор цели (или уже нет). */
  expectYard(simId: number, b: number | null): void {
    if (b === null) this.incomingYard.delete(simId);
    else this.incomingYard.set(simId, b);
  }

  yardPark(b: number, car: number): void {
    let s = this.yards.get(b);
    if (!s) this.yards.set(b, (s = new Set()));
    s.add(car);
  }

  yardUnpark(b: number, car: number): void {
    this.yards.get(b)?.delete(car);
  }

  /** Двор занят грузовиком (у склада двор общий с рампой). */
  yardBusy(b: number): boolean {
    return !!this.host.yardBusy?.(b);
  }

  /** Машине не хватило места на площадке. */
  noteRefused(lot: ParkingLot): void {
    (lot.month ??= emptyStats()).refused++;
  }

  /** Занятость мест (слой 🅿️): по месту — занято ли. */
  occupancy(): { pos: Vec; total: number; used: number }[] {
    const out: { pos: Vec; total: number; used: number }[] = [];
    for (const { lot } of this.all()) {
      lotLayout(lot).stalls.forEach((s, i) => out.push({ pos: s.pos, total: 1, used: this.occupied(lot.id, i) ? 1 : 0 }));
    }
    return out;
  }

  /** Занято мест на площадке сейчас. */
  usedCount(lot: ParkingLot): number {
    const n = lotLayout(lot).stalls.length;
    let used = 0;
    for (let i = 0; i < n; i++) if (this.occupied(lot.id, i)) used++;
    return used;
  }
}

export function emptyStats(): LotStats {
  return { cars: 0, refused: 0, left: 0, stay: 0, who: [0, 0, 0, 0] };
}

/** Место у цели — кто это: 🏠 жилой дом, 🛒 магазин и рынок, 🏭 прочие деловые; у станции (P+R) — 🚉. */
export function lotWho(dest: TownBuilding | null, station: boolean): 0 | 1 | 2 | 3 {
  if (station) return 3;
  if (!dest || dest.kind === 'res') return 0;
  const f = dest.form;
  return f === 'shop' || f === 'store' || f === 'market' ? 1 : 2;
}

export { LOT };

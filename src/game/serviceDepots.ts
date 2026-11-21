import { hash } from '../core/math';
import { dist, type Vec } from '../core/vec';
import type { LaneGraph } from '../lanes/graph';
import type { LaneNet } from '../lanes/model';
import type { LaneTraffic } from '../lanes/traffic';
import type { Vehicle } from '../sim/vehicle';
import type { HouseForm, ServiceAway, Town, TownBuilding } from '../world/entities';
import { formOf } from '../world/townForms';
import { yardLotOf, yardSpots } from '../world/yardLots';
import { carSpot, Garages, type CarSpot, type GarageLook, type SpotAhead } from './garages';
import { SERVICES, type ServiceKind } from './services';

/**
 * Станции служб: машины службы принадлежат зданию города и стоят на его стоянке (docs/DESIGN.md, «Спецтранспорт»).
 * Пока такое здание есть только у скорой — больница: между крыльями у улицы стоянка на 2–4 места (по размеру города,
 * world/yardLots.hospitalPlan), скорых у больницы — ровно по местам. Вызов (services.ts: serviceCall — куда и с мигалкой
 * ли) в городе с больницей принимает она, в городе без больницы — ближайшая больница другого города, до вызова от
 * которой есть путь. Свободная скорая выезжает со своего места задним ходом через тротуар на полосу (тот же манёвр, что
 * у мест панелек и домов старого центра: game/garages.ts — свой экземпляр под кузов скорой), едет к дому вызова, стоит
 * там DEPOT_TRIPS.stay (у узла дома, как машины жителей у цели) и возвращается: от узла вызова к своему месту, на полосе
 * напротив него — поворот передом на место. Все на вызовах — вызов ждёт следующую (не принят). Полиции и пожарной
 * зданий нет — их выезды, как прежде, из здания в здание города (Game.spawnService).
 *
 * Не на месте — Town.serviceAway города станции (сохраняется): у какого узла стоит и до когда. Кто едет — только в
 * памяти: после загрузки едущие к вызову — у вызова, едущие обратно — снова у вызова и возвращаются, выезжавшие со
 * двора — на месте. Без генератора случайных чисел партии: сколько стоять у вызова — хешем машины и времени.
 */
export const DEPOT_FORMS: Partial<Record<ServiceKind, HouseForm>> = { ambulance: 'hospital' };

export const DEPOT_TRIPS = {
  /** Сколько машина службы стоит у вызова, с игры (минута — месяц): от и до. */
  stay: [20, 45] as [number, number],
  /** Город без станции — к нему едут из стольких ближних городов со станцией (первая, откуда есть путь и есть свободная). */
  near: 3,
  /**
   * Не свернула к своему месту (проехала мимо, место занято манёвром) или не встала в поток у вызова — пробует снова
   * через retry с, не больше tries раз; дальше — на месте (дорогу к нему снесли: иначе стояла бы у вызова вечно).
   */
  tries: 5,
  retry: 3,
};

/** Машина службы: станция (здание и его город), номер места, место манёвра и где стоит на нём. */
export interface DepotCar {
  key: number;
  kind: ServiceKind;
  town: Town;
  b: TownBuilding;
  k: number;
  spot: CarSpot;
  look: { pos: Vec; dir: Vec };
}

/** Что станциям служб нужно от игры. */
export interface DepotHost {
  readonly seed: number;
  readonly time: number;
  readonly towns: readonly Town[];
  readonly traffic: LaneTraffic;
  readonly graph: LaneGraph;
  readonly net: LaneNet;
  canJoin(): boolean;
  /** Машина службы встала в поток (выезд или обратный путь): её — в счёт спецмашин, для карточки — откуда куда. */
  own(sim: Vehicle, kind: ServiceKind, trip: { from: TownBuilding; to: TownBuilding }): void;
  /** Сворачивая на место, ушла с полосы — снята с потока. */
  gone(sim: Vehicle): void;
  /** Есть ли путь по дорогам от узла from к узлу to. */
  reaches(from: number, to: number): boolean;
}

/** Ключ машины службы: здание × 8 + номер места (мест у станции меньше 8). */
const depotKey = (b: number, k: number) => b * 8 + k;

export class ServiceDepots {
  /** Манёвры у мест — по службе: у каждой свой кузов. */
  private garages = new Map<ServiceKind, Garages>();
  /** Машины станции по зданию: раскладка — по участку и числу мест (sig). */
  private cars = new Map<number, { sig: string; b: TownBuilding; town: Town; list: DepotCar[] }>();
  /** Станции города — по массиву его домов. */
  private depots = new Map<number, { of: TownBuilding[]; n: number; list: TownBuilding[] }>();
  /** Машины (ключи), что сейчас на манёвре у места или в потоке. */
  private moving = new Set<number>();
  /** Машина в потоке (id) → машина службы; home — едет на своё место. */
  private driving = new Map<number, { car: DepotCar; home: boolean }>();
  /** Сколько раз машина не смогла вернуться (DEPOT_TRIPS.tries). */
  private fails = new Map<number, number>();

  constructor(private host: DepotHost) {}

  /** Манёвры машин службы kind у мест (Garages со своим кузовом). */
  private garagesOf(kind: ServiceKind): Garages {
    let g = this.garages.get(kind);
    if (g) return g;
    const host = this.host;
    const { color, ...car } = SERVICES[kind].spec;
    g = new Garages({
      get seed() {
        return host.seed;
      },
      get traffic() {
        return host.traffic;
      },
      get graph() {
        return host.graph;
      },
      get net() {
        return host.net;
      },
      car,
      colors: [color],
      canJoin: () => host.canJoin(),
      own: (sim, trip) => host.own(sim, kind, trip),
      gone: (sim) => {
        this.driving.delete(sim.id);
        host.gone(sim);
      },
    });
    this.garages.set(kind, g);
    return g;
  }

  /** Станции города (здания служб). */
  depotsOf(town: Town): TownBuilding[] {
    const hit = this.depots.get(town.id);
    if (hit && hit.of === town.buildings && hit.n === town.buildings.length) return hit.list;
    const list = town.buildings.filter((b) => Object.values(DEPOT_FORMS).includes(formOf(b)));
    this.depots.set(town.id, { of: town.buildings, n: town.buildings.length, list });
    return list;
  }

  /** Служба станции b (нет — не станция). */
  private kindOf(b: TownBuilding): ServiceKind | undefined {
    const form = formOf(b);
    return (Object.keys(DEPOT_FORMS) as ServiceKind[]).find((k) => DEPOT_FORMS[k] === form);
  }

  /** Машины станции b города town: по местам её стоянки (yardLots: места с заездом с улицы). */
  carsOf(town: Town, b: TownBuilding): DepotCar[] {
    const kind = this.kindOf(b);
    if (!kind) return [];
    const sig = `${b.fp.center.x},${b.fp.center.y},${b.fp.w},${b.fp.h},${b.fp.angle},${b.face},${b.bays}`;
    const hit = this.cars.get(b.id);
    if (hit && hit.sig === sig && hit.b === b && hit.town === town) return hit.list;
    const spec = SERVICES[kind].spec;
    const lot = yardLotOf(b);
    const list: DepotCar[] = [];
    if (lot) {
      const spots = yardSpots(b, lot, spec.length).spots;
      spots.forEach((s, k) => {
        if (!s.drive || k >= 8) return;
        const key = depotKey(b.id, k);
        list.push({ key, kind, town, b, k, spot: carSpot(key, b, s.drive, true, spec.color, spec.length), look: { pos: s.nose, dir: s.dir } });
      });
    }
    this.cars.set(b.id, { sig, b, town, list });
    return list;
  }

  /** Машина не на месте: запись в Town.serviceAway её города. */
  private awayOf(car: DepotCar): ServiceAway | undefined {
    return car.town.serviceAway?.find((e) => e.b === car.b.id && e.k === car.k);
  }

  /** Машина на месте: не на вызове, не в пути и не на манёвре. */
  isHome(car: DepotCar): boolean {
    return !this.moving.has(car.key) && !this.awayOf(car) && !this.garagesOf(car.kind).isBusy(car.key);
  }

  /** Сколько стоит у вызова: хешем машины и времени. */
  private stay(car: DepotCar): number {
    const [lo, hi] = DEPOT_TRIPS.stay;
    return lo + (hi - lo) * hash(car.key ^ this.host.seed, Math.floor(this.host.time * 10));
  }

  /** Записать машину не на месте (у узла node, к дому to) до until. */
  private goAway(car: DepotCar, node: number, until: number, to?: TownBuilding): void {
    const list = (car.town.serviceAway ??= []);
    let e = this.awayOf(car);
    if (!e) {
      e = { b: car.b.id, k: car.k, node, until };
      list.push(e);
    }
    e.node = node;
    e.until = until;
    if (to) {
      e.at = to.id;
      e.t = to.townId;
    }
  }

  /** Машина на месте: из Town.serviceAway. */
  private settle(car: DepotCar): void {
    this.moving.delete(car.key);
    this.fails.delete(car.key);
    const list = car.town.serviceAway;
    if (!list) return;
    const i = list.findIndex((e) => e.b === car.b.id && e.k === car.k);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) delete car.town.serviceAway;
  }

  /**
   * Станции, что едут на вызов службы kind в город town к дому to: своя (в городе есть) или ближние со станцией (не
   * больше DEPOT_TRIPS.near, по расстоянию), от которых до вызова есть путь. Нет — пусто.
   */
  private depotsFor(kind: ServiceKind, town: Town, to: TownBuilding): { town: Town; b: TownBuilding }[] {
    const form = DEPOT_FORMS[kind];
    if (!form) return [];
    const of = (t: Town) => this.depotsOf(t).filter((b) => formOf(b) === form && this.carsOf(t, b).length);
    const own = of(town);
    const near = own.length
      ? own.map((b) => ({ town, b }))
      : this.host.towns
          .filter((t) => t !== town)
          .flatMap((t) => of(t).map((b) => ({ town: t, b })))
          .sort((x, y) => dist(x.b.fp.center, to.fp.center) - dist(y.b.fp.center, to.fp.center) || x.b.id - y.b.id)
          .slice(0, DEPOT_TRIPS.near);
    return near.filter((x) => this.host.reaches(x.b.anchor, to.anchor));
  }

  /**
   * Вызов службы kind в город town к дому to: свободная машина ближней станции (depotsFor) выезжает со своего места
   * (siren — с мигалкой). 'none' — станции, откуда доехать, нет (вызов — как прежде, Game.spawnService); 'busy' — все
   * её машины на вызовах (вызов не принят); 'sent' — выехала.
   */
  dispatch(kind: ServiceKind, town: Town, to: TownBuilding, siren: boolean): 'sent' | 'busy' | 'none' {
    const list = this.depotsFor(kind, town, to);
    if (!list.length) return 'none';
    for (const d of list) {
      const car = this.carsOf(d.town, d.b).find((c) => this.isHome(c));
      if (!car) continue;
      this.moving.add(car.key);
      this.garagesOf(kind).leave(car.spot, car.town, to.anchor, { from: car.b, to }, {
        hooks: {
          joined: (sim) => {
            sim.siren = siren;
            this.driving.set(sim.id, { car, home: false });
            this.goAway(car, to.anchor, this.host.time + this.stay(car), to);
          },
          // Не дождалась просвета — осталась на месте.
          stayed: () => this.moving.delete(car.key),
        },
      });
      return 'sent';
    }
    return 'busy';
  }

  /**
   * Машина в потоке кончила поездку у узла (Game.onArrive, onLost): ехала к вызову — стоит у него положенное; ехала на
   * место и не свернула к нему — снова у узла, откуда скоро поедет к месту ещё раз. Не машина службы — false.
   */
  arrived(sim: Vehicle): boolean {
    const d = this.driving.get(sim.id);
    if (!d) return false;
    this.driving.delete(sim.id);
    const { car } = d;
    this.moving.delete(car.key);
    if (!d.home) {
      this.goAway(car, sim.targetNode, this.host.time + this.stay(car));
      return true;
    }
    this.retry(car, sim.targetNode);
    return true;
  }

  /** Не вышло вернуться на место: ещё раз через DEPOT_TRIPS.retry с — или, исчерпав попытки, на месте. */
  private retry(car: DepotCar, node: number): void {
    const n = (this.fails.get(car.key) ?? 0) + 1;
    if (n > DEPOT_TRIPS.tries) {
      this.settle(car);
      return;
    }
    this.fails.set(car.key, n);
    this.goAway(car, node, this.host.time + DEPOT_TRIPS.retry);
  }

  /** Машина службы в потоке (id): какая и едет ли на место. */
  carOfSim(simId: number): { car: DepotCar; home: boolean } | undefined {
    return this.driving.get(simId);
  }

  /** Такт — после движения: манёвры у мест, и кто отстоял у вызова — едет на своё место. */
  step(dt: number): void {
    for (const g of this.garages.values()) g.step(dt);
    const now = this.host.time;
    for (const town of this.host.towns) {
      const list = town.serviceAway;
      if (!list?.length) continue;
      for (const e of [...list]) {
        if (e.until > now) continue;
        const b = this.depotsOf(town).find((x) => x.id === e.b);
        const car = b && this.carsOf(town, b).find((c) => c.k === e.k);
        if (!car) {
          // Станцию снесли или мест стало меньше — машины нет.
          list.splice(list.indexOf(e), 1);
          continue;
        }
        if (this.moving.has(car.key) || !this.host.canJoin()) continue;
        this.goHome(car, e);
      }
      if (!list.length) delete town.serviceAway;
    }
  }

  /** Машина у вызова (e) едет на своё место: от узла, где стоит, к повороту на место (направо или налево). */
  private goHome(car: DepotCar, e: ServiceAway): void {
    const g = this.garagesOf(car.kind);
    const way = this.host.graph.nodes.has(e.node) ? g.wayHome(e.node, car.spot) : null;
    if (!way) {
      this.retry(car, e.node);
      return;
    }
    const sim = this.host.traffic.spawn({ ...SERVICES[car.kind].spec, targetNode: way.slot.link.toNode!, route: way.route });
    if (!sim) {
      // У узла нет места встать в поток — чуть позже.
      e.until = this.host.time + DEPOT_TRIPS.retry;
      return;
    }
    const at = e.at !== undefined ? this.host.towns.find((t) => t.id === e.t)?.buildings.find((x) => x.id === e.at) : undefined;
    this.host.own(sim, car.kind, { from: at ?? car.b, to: car.b });
    this.moving.add(car.key);
    this.driving.set(sim.id, { car, home: true });
    g.toStall(sim, car.spot, car.town, way.slot, { arrived: () => this.settle(car) }, () => [car.spot]);
  }

  /** Машина в потоке кончила поездку или потерялась: места её больше не ждут (Garages.forget). */
  forget(simId: number): void {
    for (const g of this.garages.values()) g.forget(simId);
  }

  /** Едет ли машина к своему месту направо и уже встаёт напротив заезда — прижимается к бордюру (Garages.pulls). */
  pulls(sim: Vehicle): boolean {
    for (const g of this.garages.values()) if (g.pulls(sim)) return true;
    return false;
  }

  /** Линия маршрута выбранной машины службы у места (Garages.aheadOf). */
  aheadOf(simId: number): SpotAhead | null {
    for (const g of this.garages.values()) {
      const a = g.aheadOf(simId);
      if (a) return a;
    }
    return null;
  }

  /** Машины служб в кадре: на манёвре у мест — всегда, на местах — если parked (вблизи, как машины жителей). */
  looks(box: [number, number, number, number], parked: boolean): GarageLook[] {
    const out: GarageLook[] = [];
    for (const g of this.garages.values()) out.push(...g.looks([], box, false));
    if (!parked) return out;
    const pad = 30;
    for (const town of this.host.towns) {
      for (const b of this.depotsOf(town)) {
        const c = b.fp.center;
        if (c.x < box[0] - pad || c.x > box[2] + pad || c.y < box[1] - pad || c.y > box[3] + pad) continue;
        for (const car of this.carsOf(town, b)) {
          if (!this.isHome(car)) continue;
          const { color, ...spec } = SERVICES[car.kind].spec;
          out.push({ look: { ...spec, color, pos: car.look.pos, dir: car.look.dir } });
        }
      }
    }
    return out;
  }
}

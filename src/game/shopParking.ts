import { hash } from '../core/math';
import { add, scale } from '../core/vec';
import type { Vehicle, VehicleSpec } from '../sim/vehicle';
import type { HouseForm, ShopCar, Town, TownBuilding } from '../world/entities';
import { shopLotOf, stallDriveways } from '../world/shopLots';
import { formOf } from '../world/townForms';
import { carSpot, type CarSpot, type GarageLook, type Garages, type GarageSlot, type MoveHooks } from './garages';

/**
 * Стоянки покупателей у магазинов, сельских магазинов и рынков (docs/DESIGN.md, «Машины жителей»): часть поездок
 * горожан к магазину кончается не у узла, а на его стоянке. Машина подъезжает, на полосе у стоянки выбирает
 * свободное место (нет — проезжает мимо), с поворотником сворачивает к нему и встаёт передом; стоит 1–4 минуты,
 * выезжает задним ходом к бордюру, ждёт просвета и уезжает домой. Манёвр — тот же, что у гаражей частных домов
 * (game/garages.ts: место стоянки — CarSpot, что делать на вехах манёвра — MoveHooks).
 *
 * Всё — без генератора случайных чисел партии: поедет ли на стоянку, сколько простоит и куда потом — по seed, номеру
 * решения города (Town.shopVisits) и хешу; машины в начале партии — по хешу id магазина. Занятые места — в городе
 * (Town.shopParked: место, цвет, до какого времени стоит), сохраняются с ним; манёвры не сохраняются (машина,
 * сворачивавшая на стоянку, в сохранении не стоит на ней; выезжавшая — стоит и выедет снова).
 */
export const SHOP_PARKING = {
  /**
   * Доля поездок к магазину, что кончаются на его стоянке: perStall за каждое место, не больше max. К магазину
   * (работа или покупки) едет ~55 % поездок жителей, на магазин — ~3,5 поездки в минуту; у стоянки на 3 места —
   * 0,6 машины в минуту, стоят в среднем 2 минуты: занято в среднем 1–1,5 места из 3, полной она бывает, но не всегда.
   * У универмага на 8 мест — 1,4 машины в минуту.
   */
  perStall: 0.3,
  max: 0.9,
  /** Сколько стоит, с игры (минута — месяц, MONTH_LENGTH): от min до max, чаще — около полутора-двух минут. */
  stay: { min: 60, max: 240 },
  /** Машин на стоянке в начале партии — 0…startMax, по хешу. */
  startMax: 2,
  /** Выехать не вышло (места в потоке нет, сосед на манёвре, не дождалась просвета) — снова через столько, с. */
  retry: 6,
  /** Как часто проверять, кому пора уезжать, с. */
  tick: 0.5,
};

/** Что стоянкам нужно от игры. */
export interface ShopHost {
  readonly seed: number;
  /** Время партии, с. */
  readonly time: number;
  /** Кузов машины жителя (без цвета). */
  readonly car: Omit<VehicleSpec, 'color'>;
  readonly colors: readonly string[];
  /** Можно ли сейчас ещё одной машине жителя в поток (TOWN_TRAFFIC.maxCars). */
  canDrive(): boolean;
  /** У дома грузовик на манёвре во дворе (game/docks.ts): двор общий — машинам покупателей ждать. */
  yardBusy?(b: number): boolean;
  /**
   * Машина парка жителей (ShopCar.car) уезжает со стоянки магазина from — на своё место (game/carHomes.ts): к какому
   * месту, путь к нему (slot), дом машины и что сделать, когда встала в поток и когда тронулась по полосе. Нет своего
   * места или к нему не подъехать — null: едет к случайному дому, как прочие.
   */
  backHome?(town: Town, car: ShopCar, from: TownBuilding): FleetBack | null;
}

/** Куда машине парка жителей со стоянки магазина (ShopHost.backHome). */
export interface FleetBack {
  /** Куда — для карточки машины: дом места (у бокса — гаражи). */
  home: TownBuilding;
  to: CarSpot;
  slot: GarageSlot;
  joined(sim: Vehicle): void;
  then(sim: Vehicle): void;
}

/** Машина парка жителей едет на стоянку: её ключ и что сделать, когда встала на место (ключ места). */
export interface FleetVisit {
  car: number;
  parked(spot: number): void;
}

/** Стоянка магазина: места (в мире) и их группы (соседи — в одной группе через одно). */
interface Lot {
  b: TownBuilding;
  form: HouseForm;
  fp: TownBuilding['fp'];
  spots: CarSpot[];
  /** Номер группы каждого места. */
  group: number[];
}

/** Решение о поездке на стоянку: к какому месту прокладывать путь (примерное: какое займёт — решится у стоянки). */
export interface ShopVisit {
  town: Town;
  lot: Lot;
  planned: CarSpot;
  slot: GarageSlot;
  /** Номер решения — от него хеш, сколько простоит. */
  n: number;
}

/** Ключ места стоянки — отрицательный (у дома ключ — его id): магазин и номер места. */
export function stallKey(building: number, k: number): number {
  return -(building * 64 + k + 1);
}

/** Номер решения города → зерно хеша: по seed партии, без общего генератора. */
function visitSeed(seed: number, town: number, n: number): number {
  return (Math.imul(seed >>> 0, 0x2c1b3c6d) ^ Math.imul(town + 7, 0x297a2d39) ^ Math.imul(n, 0x85ebca6b)) >>> 0;
}

/** Сколько простоит: min…max, чаще — ближе к min (u²). */
function stayOf(u: number): number {
  const { min, max } = SHOP_PARKING.stay;
  return min + (max - min) * Math.sqrt(u);
}

export class ShopParking {
  private lots = new Map<number, Lot | null>();
  private acc = 0;

  constructor(
    private host: ShopHost,
    private garages: Garages,
  ) {}

  /** Стоянка у дома (магазин, сельский магазин, рынок); нет мест — null. Дом перестроили — заново. */
  lotOf(b: TownBuilding): Lot | null {
    const form = formOf(b);
    const hit = this.lots.get(b.id);
    if (hit !== undefined && (hit === null || (hit.form === form && hit.fp === b.fp && hit.b === b))) return hit;
    if (hit) for (const s of hit.spots) this.garages.forgetSlot(s.key);
    let lot: Lot | null = null;
    const plan = shopLotOf(b);
    if (plan?.groups.length) {
      const drives = stallDriveways(b);
      const group: number[] = [];
      plan.groups.forEach((g, i) => g.stalls.forEach(() => group.push(i)));
      const L = this.host.car.length;
      lot = { b, form, fp: b.fp, group, spots: drives.map((d, k) => carSpot(stallKey(b.id, k), b, d, true, '#888888', L)) };
    }
    this.lots.set(b.id, lot);
    return lot;
  }

  /** Занятые места стоянки дома b: номера мест. */
  parkedAt(town: Town, b: number): ShopCar[] {
    return (town.shopParked ?? []).filter((c) => c.b === b);
  }

  /** Место свободно: на нём не стоит машина и к нему никто не едет и не выезжает с него; двор не занят грузовиком. */
  private free(town: Town, lot: Lot, k: number): boolean {
    return !this.garages.isBusy(lot.spots[k].key) && !town.shopParked?.some((c) => c.b === lot.b.id && c.k === k) && !this.host.yardBusy?.(lot.b.id);
  }

  /** У дома b машина покупателя на манёвре — заезжает на место или выезжает с него (двор занят для грузовика). */
  lotBusy(b: number): boolean {
    const lot = this.lots.get(b);
    if (!lot) return false;
    for (const s of lot.spots) if (this.garages.moveOf(s.key)) return true;
    return false;
  }

  /** Соседнее место (в той же группе) — на манёвре: заезжать или выезжать рядом нельзя, кузова заденут друг друга. */
  private neighbourBusy(lot: Lot, k: number): boolean {
    for (const j of [k - 1, k + 1]) if (j >= 0 && j < lot.spots.length && lot.group[j] === lot.group[k] && this.garages.isBusy(lot.spots[j].key)) return true;
    return false;
  }

  /**
   * Машины на стоянках в начале партии (и у старых сохранений — при загрузке): у каждой стоянки, к которой можно
   * подъехать, 0–2 машины (по хешу id дома) на местах по хешу, стоят ещё сколько-то из своего срока.
   */
  seed(towns: readonly Town[]): void {
    const colors = this.host.colors;
    for (const town of towns) {
      if (town.shopParked) continue;
      const list: ShopCar[] = [];
      for (const b of town.buildings) {
        const lot = b.kind === 'com' ? this.lotOf(b) : null;
        if (!lot || !lot.spots.some((s) => this.garages.slotOf(s))) continue;
        const n = Math.min(lot.spots.length, Math.floor(hash(b.id, 71) * (SHOP_PARKING.startMax + 1)));
        const taken = new Set<number>();
        for (let i = 0; i < n; i++) {
          let k = Math.floor(hash(b.id, 72 + i) * lot.spots.length);
          while (taken.has(k)) k = (k + 1) % lot.spots.length;
          taken.add(k);
          const color = colors[Math.floor(hash(b.id, 75 + i) * colors.length)];
          list.push({ b: b.id, k, color, until: this.host.time + stayOf(hash(b.id, 78 + i)) * hash(b.id, 81 + i) });
        }
      }
      town.shopParked = list;
    }
  }

  /**
   * Поездка жителя к дому dest города town — на его стоянку? Решение по хешу (Town.shopVisits): доля — по числу мест
   * (SHOP_PARKING.perStall). Стоянки нет или к ней не подъехать — null: поездка обычная, к узлу.
   */
  visit(town: Town, dest: TownBuilding): ShopVisit | null {
    if (dest.kind !== 'com') return null;
    const lot = this.lotOf(dest);
    if (!lot) return null;
    const n = (town.shopVisits = (town.shopVisits ?? 0) + 1);
    const p = Math.min(SHOP_PARKING.max, SHOP_PARKING.perStall * lot.spots.length);
    if (hash(visitSeed(this.host.seed, town.id, n), 1) >= p) return null;
    // Путь — к связи у среднего из мест, к которым можно подъехать (места одной группы — у одной связи).
    const reach = lot.spots.map((s) => ({ s, slot: this.garages.slotOf(s) })).filter((x) => x.slot);
    if (!reach.length) return null;
    const mid = reach[Math.floor(reach.length / 2)];
    return { town, lot, planned: mid.s, slot: mid.slot!, n };
  }

  /**
   * Машина в потоке sim едет на стоянку visit (маршрут — к связи у неё, Garages.routeHome); fleet — это машина парка
   * жителей (уезжая, поедет на своё место).
   */
  start(sim: Vehicle, v: ShopVisit, fleet?: FleetVisit): void {
    const { town, lot } = v;
    const stay = stayOf(hash(visitSeed(this.host.seed, town.id, v.n), 2));
    const color = sim.color;
    const hooks: MoveHooks = {
      arrived: (spot) => {
        const k = lot.spots.indexOf(spot);
        // Стоянку перестроили, пока заезжала, — машина «уехала» незаметно.
        if (k < 0 || this.lots.get(lot.b.id) !== lot) return;
        const car: ShopCar = { b: lot.b.id, k, color, until: this.host.time + stay };
        if (fleet) car.car = fleet.car;
        (town.shopParked ??= []).push(car);
        fleet?.parked(spot.key);
      },
    };
    // Какое место занять, решает Garages у стоянки (ближнее свободное, до которого успеть остановиться).
    const choices = () => lot.spots.filter((_, k) => this.free(town, lot, k) && !this.neighbourBusy(lot, k));
    this.garages.toStall(sim, v.planned, town, v.slot, hooks, choices);
  }

  /**
   * Такт: кому пора уезжать — выезжает задним ходом к бордюру (Garages.leave) и едет домой — в жилой дом своего города
   * по хешу. Нельзя сейчас (сосед на манёвре, в потоке нет места) — через SHOP_PARKING.retry. Машины снесённых или
   * перестроенных магазинов — убираются.
   */
  step(dt: number, towns: readonly Town[]): void {
    this.acc += dt;
    if (this.acc < SHOP_PARKING.tick) return;
    this.acc = 0;
    const now = this.host.time;
    for (const town of towns) {
      const list = town.shopParked;
      if (!list?.length) continue;
      let byId: Map<number, TownBuilding> | null = null;
      for (let i = 0; i < list.length; i++) {
        const car = list[i];
        if (car.until > now) continue;
        byId ??= new Map(town.buildings.map((b) => [b.id, b]));
        const b = byId.get(car.b);
        const lot = b && this.lotOf(b);
        if (!lot || car.k >= lot.spots.length) {
          list.splice(i--, 1);
          continue;
        }
        const spot = lot.spots[car.k];
        if (this.garages.isBusy(spot.key)) continue;
        // Машина парка жителей — на своё место (game/carHomes.ts), как машина со двора едет к стоянке.
        const back = car.car !== undefined ? (this.host.backHome?.(town, car, b) ?? null) : null;
        if (back) {
          if (!this.garages.slotOf(spot) || this.neighbourBusy(lot, car.k) || this.host.yardBusy?.(lot.b.id) || !this.host.canDrive()) {
            car.until = now + SHOP_PARKING.retry;
            continue;
          }
          const hooks: MoveHooks = {
            joined: (sim) => {
              const at = town.shopParked?.indexOf(car) ?? -1;
              if (at >= 0) town.shopParked!.splice(at, 1);
              back.joined(sim);
            },
            stayed: () => {
              car.until = this.host.time + SHOP_PARKING.retry;
            },
          };
          const trip = { from: b, to: back.home };
          this.garages.leave(spot, town, back.slot.link.toNode!, trip, { color: car.color, hooks, endLink: back.slot.link.id, to: back.to, then: back.then });
          continue;
        }
        const homes = town.buildings.filter((x) => x.kind === 'res');
        const n = (town.shopVisits = (town.shopVisits ?? 0) + 1);
        const home = homes.length ? homes[Math.floor(hash(visitSeed(this.host.seed, town.id, n), 3) * homes.length)] : null;
        if (!home || !this.garages.slotOf(spot) || this.neighbourBusy(lot, car.k) || this.host.yardBusy?.(lot.b.id) || !this.host.canDrive()) {
          car.until = now + SHOP_PARKING.retry;
          continue;
        }
        const hooks: MoveHooks = {
          joined: () => {
            const at = town.shopParked?.indexOf(car) ?? -1;
            if (at >= 0) town.shopParked!.splice(at, 1);
          },
          stayed: () => {
            car.until = this.host.time + SHOP_PARKING.retry;
          },
        };
        this.garages.leave(spot, town, home.anchor, { from: b, to: home }, { color: car.color, hooks });
      }
    }
  }

  /**
   * Машины на стоянках в кадре — вблизи (parked, как машины у гаражей): стоящие на местах, кроме тех, что сейчас
   * выезжают (их рисует манёвр). box — [x0, y0, x1, y1] кадра.
   */
  looks(towns: readonly Town[], box: [number, number, number, number], parked: boolean): GarageLook[] {
    const out: GarageLook[] = [];
    if (!parked) return out;
    const spec = this.host.car;
    for (const town of towns) {
      const list = town.shopParked;
      if (!list?.length) continue;
      const r = town.radius + 200;
      if (town.center.x + r < box[0] || town.center.x - r > box[2] || town.center.y + r < box[1] || town.center.y - r > box[3]) continue;
      for (const car of list) {
        const lot = this.lots.has(car.b) ? this.lots.get(car.b) : this.lotById(town, car.b);
        const spot = lot?.spots[car.k];
        if (!spot || this.garages.isBusy(spot.key)) continue;
        const p = spot.spot;
        if (p.x < box[0] - 10 || p.x > box[2] + 10 || p.y < box[1] - 10 || p.y > box[3] + 10) continue;
        out.push({ look: { ...spec, color: car.color, pos: add(p, scale(spot.d.dir, spec.length / 2)), dir: spot.d.dir } });
      }
    }
    return out;
  }

  /** Стоянка дома по id (дом ищется в городе — только если её ещё не считали). */
  private lotById(town: Town, id: number): Lot | null {
    const b = town.buildings.find((x) => x.id === id);
    return b ? this.lotOf(b) : null;
  }
}

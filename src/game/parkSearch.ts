import { dist, type Vec } from '../core/vec';
import type { GLink, LaneGraph } from '../lanes/graph';
import { findLaneRoute, routeCost } from '../lanes/routing';
import type { LaneTraffic } from '../lanes/traffic';
import type { Vehicle } from '../sim/vehicle';
import type { Town, TownBuilding } from '../world/entities';
import { LOT } from '../world/parkingLots';
import type { CarHomes, FleetTrip } from './carHomes';
import { CURB_TRIPS, type CurbParking } from './curbParking';
import type { CarSpot, Garages, GarageSlot } from './garages';
import type { LotParking, LotRef } from './lotParking';
import type { CurbStall } from '../lanes/curb';
import { PARKING_LAYER } from './parkingLayer';

/**
 * Поиск места у цели поездки (docs/PARKING.md, этап 3). Места цели: полосы стоянки на её улице и соседних
 * (CurbParking, CURB_TRIPS.destRange), площадки не дальше LOT.near (LotParking); свои места магазина — его стоянка
 * (ShopParking, решается раньше). Куда ехать — что быстрее, с надбавкой за ходьбу (CURB_TRIPS.walk с за ед.); какое
 * место — ближнее свободное на подъезде.
 *
 * Не нашлось (заняли, пока ехала; свободных нет вовсе) — до PARK_SEARCH.tries попыток не дальше PARK_SEARCH.range от цели
 * и PARK_SEARCH.window с: машина переезжает к следующему месту (traffic.redirect с новой последней связью). Не нашла —
 * едет домой, на своё место (отказ клетки: Town.parkRefused). Исчезает, только если и к своему месту не доехать. Мест
 * у цели нет вовсе (окраина, гости) — как прежде: поездка кончается у узла цели. Всё — без генератора случайных чисел.
 */
export const PARK_SEARCH = {
  /** Попыток после первой неудачи. */
  tries: 3,
  /** Следующее место — не дальше стольких ед. от цели (≈ 300 м). */
  range: 500,
  /** Ищет не дольше стольких с с первой неудачи. */
  window: 60,
  /** «🅿️✕» над целью — ещё столько с после отказа. */
  mark: 8,
};

/** Куда ехать за местом: связь у полосы стоянки или площадка (маленькая — через ворота, большая — к узлу). */
export type ParkChoice =
  | { kind: 'curb'; key: string; link: GLink; choices: () => CurbStall[]; full: boolean }
  | { kind: 'yard'; key: string; b: TownBuilding; spot: CarSpot; slot: GarageSlot; route: number[]; full: boolean }
  | { kind: 'lot'; key: string; ref: LotRef; spot?: CarSpot; slot?: GarageSlot; node?: number; route?: number[]; full: boolean };

/** Ищет место: машина, куда ехала, сколько попыток, с какого времени, где уже была. */
interface Search {
  trip: Extract<FleetTrip, { kind: 'out' }>;
  dest: TownBuilding;
  town: Town | undefined;
  tries: number;
  t0: number | null;
  tried: Set<string>;
  choice: ParkChoice;
}

/** Что поиску нужно от игры. */
export interface SearchHost {
  readonly time: number;
  readonly graph: LaneGraph;
  readonly traffic: LaneTraffic;
  /** Город цели (по id). */
  townOf(id: number): Town | undefined;
}

export class ParkSearch {
  private searching = new Map<number, Search>();
  /** Недавние отказы: где (цель) и до какого времени показывать «🅿️✕». */
  private marks: { pos: Vec; until: number }[] = [];

  constructor(
    private host: SearchHost,
    private curb: CurbParking,
    private lots: LotParking,
    private garages: Garages,
    private homes: CarHomes,
  ) {}

  /**
   * Куда ехать за местом к цели dest со связей starts (from — u на первой: машина уже на ней): свободное — что быстрее с
   * ходьбой; свободных нет, но места есть — к ближнему (full: там поищет, кто-то мог уехать). Без skip; curbR и lotR —
   * насколько далеко от цели. Мест нет вовсе — null.
   */
  plan(dest: TownBuilding, starts: GLink[], skip: ReadonlySet<string> = new Set(), lotR: number = LOT.near, curbR: number = CURB_TRIPS.destRange, u = 0): ParkChoice | null {
    const g = this.host.graph;
    const pos = dest.fp.center;
    const skipLinks = new Set([...skip].filter((k) => k.startsWith('c')).map((k) => Number(k.slice(1))));
    // Свой двор цели (склад, оптовая база, гаражи) — первым: там место «своё».
    const ys = !skip.has(`y${dest.id}`) && this.lots.yardFree(dest) ? this.lots.yardSpot(dest) : null;
    const yw = ys && this.garages.wayFrom(starts, ys, u);
    if (ys && yw) return { kind: 'yard', key: `y${dest.id}`, b: dest, spot: ys, slot: yw.slot, route: yw.route, full: false };
    let best: { c: ParkChoice; cost: number } | null = null;
    const cv = this.curb.visitFrom(pos, starts, skipLinks, curbR);
    if (cv) best = { c: { kind: 'curb', key: `c${cv.link.id}`, link: cv.link, choices: cv.choices, full: false }, cost: cv.cost };
    const lots = this.lots.near(pos, lotR).filter((x) => !skip.has(`l${x.lot.id}`));
    const routeTo = (ref: LotRef): Omit<Extract<ParkChoice, { kind: 'lot' }>, 'full' | 'key' | 'kind' | 'ref'> & { cost: number } | null => {
      if (this.lots.big(ref.lot)) {
        const w = this.lots.wayToBig(ref.lot, starts);
        return w ? { node: w.node, route: w.route, cost: routeCost(g, w.route) } : null;
      }
      let res: { spot: CarSpot; slot: GarageSlot; route: number[]; cost: number } | null = null;
      for (const spot of this.lots.spotFor(ref.lot, false)) {
        const w = this.garages.wayFrom(starts, spot, u);
        if (w && (!res || w.cost < res.cost)) res = { spot, slot: w.slot, route: w.route, cost: w.cost };
      }
      return res;
    };
    const walk = (ref: LotRef) => dist(ref.lot.fp.center, pos) * CURB_TRIPS.walk;
    for (const ref of lots) {
      if (this.lots.free(ref.lot) <= 0) continue;
      const w = routeTo(ref);
      if (!w) continue;
      const cost = w.cost + walk(ref);
      if (!best || cost < best.cost) best = { c: { kind: 'lot', key: `l${ref.lot.id}`, ref, ...w, full: false }, cost };
    }
    if (best) return best.c;
    // Свободных нет — к ближнему из тех, что есть: полоса или площадка (там и поищет).
    const any = this.curb.anyLink(pos, skipLinks, curbR);
    let near: { c: ParkChoice; d: number } | null = null;
    if (any && (!starts.length || findLaneRoute(g, starts, any.link.toNode!, any.link.id))) {
      const link = any.link.id;
      near = { c: { kind: 'curb', key: `c${link}`, link: any.link, choices: () => this.curb.freeOn(pos, link, curbR), full: true }, d: any.d };
    }
    for (const ref of lots) {
      if (this.lots.guestStalls(ref.lot) <= 0) continue;
      const d = dist(ref.lot.fp.center, pos);
      if (near && d >= near.d) continue;
      const w = routeTo(ref);
      if (w) near = { c: { kind: 'lot', key: `l${ref.lot.id}`, ref, ...w, full: true }, d };
    }
    return near?.c ?? null;
  }

  /** Машина sim (выехала с места к цели dest) встала в поток: едет к месту choice. */
  start(sim: Vehicle, trip: Extract<FleetTrip, { kind: 'out' }>, dest: TownBuilding, choice: ParkChoice): void {
    const s: Search = { trip, dest, town: this.host.townOf(dest.townId), tries: 0, t0: null, tried: new Set([choice.key]), choice };
    this.searching.set(sim.id, s);
    this.attach(sim, s);
  }

  private attach(sim: Vehicle, s: Search): void {
    const c = s.choice;
    s.choice = c;
    const miss = () => this.miss(sim, s);
    if (c.kind === 'curb') this.homes.toCurbVisit(sim, s.trip, { link: c.link, choices: c.choices }, miss);
    else if (c.kind === 'yard') this.homes.toYardVisit(sim, s.trip, c.b, { spot: c.spot, slot: c.slot }, miss);
    else this.homes.toLotVisit(sim, s.trip, c.ref, { spot: c.spot, slot: c.slot }, miss, s.dest);
  }

  /** Где машина сейчас: связи, с которых считать путь, начало пути (на повороте — связь до него) и u на связи. */
  private where(sim: Vehicle): { starts: GLink[]; prefix: number[]; u: number } | null {
    const g = this.host.graph;
    if (sim.onMovement) {
      const m = g.moves.get(sim.onMovement);
      const out = m && g.links.get(m.outLink);
      return m && out ? { starts: [out], prefix: [m.inLink], u: 0 } : null;
    }
    const lane = this.host.traffic.currentLane(sim);
    const link = lane && g.links.get(lane.link);
    return link ? { starts: [link], prefix: [], u: sim.s } : null;
  }

  /** Едет туда: последняя связь endLink (нет — к узлу), путь — готовый или кратчайший оттуда, где машина. */
  private go(sim: Vehicle, at: { starts: GLink[]; prefix: number[] }, toNode: number, endLink: number | undefined, route?: number[]): boolean {
    const r = route ?? findLaneRoute(this.host.graph, at.starts, toNode, endLink);
    if (!r || !this.host.traffic.redirect(sim, toNode, [...at.prefix, ...r])) return false;
    if (endLink !== undefined) sim.endLink = endLink;
    else delete sim.endLink;
    return true;
  }

  /** Не нашла места: следующая попытка — или домой (отказ). */
  private miss(sim: Vehicle, s: Search): void {
    const now = this.host.time;
    s.t0 ??= now;
    const at = this.host.traffic.vehicles.has(sim.id) ? this.where(sim) : null;
    if (!at) {
      this.searching.delete(sim.id);
      return;
    }
    if (s.tries < PARK_SEARCH.tries && now - s.t0 <= PARK_SEARCH.window) {
      const next = this.plan(s.dest, at.starts, s.tried, PARK_SEARCH.range, PARK_SEARCH.range, at.u);
      if (next) {
        const end = next.kind === 'curb' ? next.link : next.slot?.link;
        const ok = next.kind === 'lot' && next.node !== undefined ? this.go(sim, at, next.node, undefined, next.route) : !!end && this.go(sim, at, end.toNode!, end.id, next.kind === 'curb' ? undefined : next.route);
        if (ok) {
          s.tries++;
          s.tried.add(next.key);
          s.choice = next;
          this.attach(sim, s);
          return;
        }
      }
    }
    // Не нашла: отказ — домой, на своё место.
    this.searching.delete(sim.id);
    this.refuse(s);
    this.homes.goHome(sim, s.trip, { starts: at.starts, u: at.u, go: (toNode, endLink, route) => this.go(sim, at, toNode, endLink, route) });
  }

  /** Отказ: клетка цели (слой 🅿️) и «🅿️✕» над ней. */
  private refuse(s: Search): void {
    const p = s.dest.fp.center;
    const size = PARKING_LAYER.cell;
    const key = `${Math.floor(p.x / size)}:${Math.floor(p.y / size)}`;
    if (s.town) {
      const r = (s.town.parkRefused ??= {});
      r[key] = (r[key] ?? 0) + 1;
    }
    this.marks.push({ pos: p, until: this.host.time + PARK_SEARCH.mark });
  }

  /** Такт: большая площадка у цели заполнилась, пока ехала, — на подъезде к узлу ворот ищет дальше; «🅿️✕» — старые прочь. */
  step(): void {
    const now = this.host.time;
    if (this.marks.length) this.marks = this.marks.filter((m) => m.until > now);
    for (const [id, s] of [...this.searching]) {
      const sim = this.host.traffic.vehicles.get(id);
      if (!sim) {
        this.searching.delete(id);
        continue;
      }
      const c = s.choice;
      if (c.kind !== 'lot' || c.node === undefined || !this.lots.isHomingBig(id)) continue;
      // Ещё не у ворот — ждём; у последних связей пути, а мест нет, — дальше.
      if (sim.route.length - sim.routeIndex > 2 || this.lots.pick(c.ref.lot, sim.pos) >= 0) continue;
      this.lots.forget(id);
    }
  }

  /** Машина кончила поездку (у узла, потерялась): поиск кончился. */
  forget(simId: number): void {
    this.searching.delete(simId);
  }

  /** Ищет ли машина место: сколько попыток сделала (из PARK_SEARCH.tries) и куда едет. */
  of(simId: number): { tries: number; dest: TownBuilding } | null {
    const s = this.searching.get(simId);
    return s && s.t0 !== null ? { tries: s.tries, dest: s.dest } : null;
  }

  /** Кружат: машины, что не нашли места с первого раза (где они), и цели, где не нашлось (в кадре — «🅿️✕»). */
  circling(): { pos: Vec; dest: Vec }[] {
    const out: { pos: Vec; dest: Vec }[] = [];
    for (const [id, s] of this.searching) {
      const sim = this.host.traffic.vehicles.get(id);
      if (sim && s.t0 !== null) out.push({ pos: sim.pos, dest: s.dest.fp.center });
    }
    return out;
  }

  /** Где показать «🅿️✕»: цели, у которых кружат, и недавние отказы. */
  badges(): Vec[] {
    const out: Vec[] = this.marks.map((m) => m.pos);
    for (const c of this.circling()) if (!out.some((p) => dist(p, c.dest) < 1)) out.push(c.dest);
    return out;
  }

  /** После загрузки: в пути никого нет. */
  clear(): void {
    this.searching.clear();
    this.marks = [];
  }
}

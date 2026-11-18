import { add, dist, dot, scale, sub, type Vec } from '../core/vec';
import type { CurbStall } from '../lanes/curb';
import type { GLink } from '../lanes/graph';
import { findLaneRoute } from '../lanes/routing';
import type { Vehicle, VehicleLook, VehicleSpec } from '../sim/vehicle';
import type { Town, TownBuilding, TownCar } from '../world/entities';
import { lotLayout } from '../world/parkingLots';
import type { FleetCar } from './carHomes';
import type { Game } from './game';
import { carSpot, type CarSpot, type GarageSlot } from './garages';
import { CAR_SIZE } from '../world/houseAccess';
import { yardLotOf, yardSpots } from '../world/yardLots';
import { stallKey } from './shopParking';
import { pocketExit } from './pocketExit';
import { garageBoxes, type GarageBoxAccess } from './garageBoxes';
import { path, runPose, type Run } from './lotMoves';

export interface ParkedCarSource {
  id: string;
  look: VehicleLook;
  town: Town;
  at: TownBuilding;
  car?: FleetCar;
  spot?: CarSpot;
  curb?: CurbStall;
  lot?: number;
  stall?: number;
  occupant?: number;
  pocket?: boolean;
  box?: GarageBoxAccess;
  remove(): void;
}

interface Destination {
  town: Town;
  b: TownBuilding;
  pos: Vec;
  spot?: CarSpot;
  curb?: CurbStall;
  lot?: number;
  stall?: number;
  home?: boolean;
  shop?: boolean;
  pocket?: boolean;
  box?: GarageBoxAccess;
}

interface Command {
  source: ParkedCarSource;
  target: Destination;
  sim?: Vehicle;
  state: 'Ждёт выезда' | 'Выезжает' | 'В пути' | 'Припарковалась' | 'Не удалось припарковаться';
  release(): void;
  arrivalId?: string;
  preview?: { pts: Vec[]; goal: Vec; dir: Vec; ok: boolean };
  arrivalHooks?: object;
}

/** Выбор стоящих машин и ручные поездки. Транспорт движется через обычные системы игры. */
export class ParkedCars {
  private extras = new Map<string, ParkedCarSource>();
  private commands = new Map<string, Command>();
  private sequence = -1_000_000;
  private roadGoals = new Map<number, { link: number; u: number; goal: Vec; dir: Vec; holding: boolean }>();
  private arrivals = new Map<number, string>();
  private queued = new Map<string, Command>();
  private destinationsCache: { key: string; list: Destination[] } | null = null;
  private assignedPlaces = new WeakMap<object, Set<number>>();
  private reservedPlaces = new Map<number, object>();

  constructor(private game: Game) {}

  arrivedCar(simId: number): string | undefined { return this.arrivals.get(simId); }

  trip(id: string | number): { pts: Vec[]; goal: Vec } | null {
    const command = typeof id === 'number' ? [...this.commands.values()].find((c) => c.sim?.id === id) : this.commands.get(id);
    if (command && (command.state === 'Ждёт выезда' || command.state === 'Выезжает' || command.state === 'В пути')) {
      const arrival = this.arrivalMove(command);
      if (arrival) {
        const r = arrival.run;
        const current = r.legs[r.i];
        const next = current.pts.findIndex((_, i) => current.cum[i] >= r.s);
        return { pts: [runPose(r).c, ...current.pts.slice(Math.max(0, next)), ...r.legs.slice(r.i + 1).flatMap((l) => l.pts)], goal: command.target.pos };
      }
      const ahead = command.sim && this.game.vehicleAhead(command.sim.id);
      return { pts: ahead?.pts ?? command.preview?.pts ?? [], goal: command.target.pos };
    }
    const goal = typeof id === 'number' ? this.roadGoals.get(id) : null;
    const ahead = goal && this.game.vehicleAhead(id as number);
    if (!goal || !ahead) return null;
    let last = 0;
    for (let i = 1; i < ahead.pts.length; i++) if (dist(ahead.pts[i], goal.goal) < dist(ahead.pts[last], goal.goal)) last = i;
    return { pts: [...ahead.pts.slice(0, last + 1), goal.goal], goal: goal.goal };
  }

  step(): void {
    for (const [id, c] of [...this.queued]) {
      if (this.blocked(c.source)) continue;
      c.release(); this.queued.delete(id); this.commands.delete(id);
      const source = this.source(id);
      const problem = source ? this.problem(c.target) ?? this.drive(source, c.target) : 'Машина уже покинула место';
      if (problem) this.game.notify(problem);
    }
    for (const [id, goal] of this.roadGoals) {
      const sim = this.game.traffic.vehicles.get(id);
      if (!sim) { this.roadGoals.delete(id); continue; }
      const lane = this.game.traffic.currentLane(sim);
      if (!goal.holding && !sim.onMovement && lane?.link === goal.link && sim.routeIndex === sim.route.length - 1) {
        this.game.traffic.holdAfter(sim, Math.max(0, goal.u - sim.s));
        goal.holding = true;
      }
    }
  }

  register(source: ParkedCarSource): void { this.extras.set(source.id, source); }

  looks(box: [number, number, number, number]): { look: VehicleLook; parkedCar: string }[] {
    return [...this.extras.values()].filter((s) => (!this.commands.has(s.id) || this.queued.has(s.id)) && s.look.pos.x > box[0] - 20 && s.look.pos.x < box[2] + 20 && s.look.pos.y > box[1] - 20 && s.look.pos.y < box[3] + 20).map((s) => ({ look: s.look, parkedCar: s.id, hidden: !!s.box }));
  }

  at(p: Vec): string | null {
    for (const { look, parkedCar } of this.game.garageLooks([p.x - 12, p.y - 12, p.x + 12, p.y + 12], true).reverse()) {
      if (!parkedCar) continue;
      const d = sub(p, add(look.pos, scale(look.dir, -look.length / 2)));
      if (Math.abs(dot(d, look.dir)) <= look.length / 2 + 0.8 && Math.abs(d.x * look.dir.y - d.y * look.dir.x) <= look.width / 2 + 0.8) return parkedCar;
    }
    return null;
  }

  get(id: string): { look: VehicleLook; place: string; state: string; parked: boolean } | null {
    const source = this.source(id);
    if (source) return { look: source.look, place: source.box ? `Гараж №${source.box.index + 1}` : this.placeName(source.at), state: this.queued.has(id) ? 'Ждёт выезда' : 'Припаркована', parked: true };
    const c = this.commands.get(id);
    if (!c) return null;
    const move = c.source.spot && this.game.garages.moveOf(c.source.spot.key);
    const arrival = this.arrivalMove(c);
    let look = move?.sim ?? c.sim ?? c.source.look;
    if (arrival) {
      const { c: pos, h: dir } = runPose(arrival.run);
      look = { ...look, pos: add(pos, scale(dir, look.length / 2)), dir };
    } else if (move && !move.sim) {
      look = { ...look, pos: move.pos, dir: move.dir };
    }
    return { look, place: c.target.box ? `Гараж №${c.target.box.index + 1}` : this.placeName(c.target.b), state: c.state, parked: false };
  }

  private placeName(b: TownBuilding): string { return b.kind === 'com' ? 'У магазина' : 'У дома'; }

  private source(id: string): ParkedCarSource | null {
    const waiting = this.queued.get(id);
    if (waiting) return waiting.source;
    const alias = this.commands.get(id)?.arrivalId;
    if (alias && alias !== id) {
      const source = this.source(alias);
      return source ? { ...source, id } : null;
    }
    const extra = this.extras.get(id);
    if (extra && (!this.commands.has(id) || this.queued.has(id))) return extra;
    const g = this.game;
    const key = id.startsWith('car:') ? Number(id.slice(4)) : undefined;
    const owner = key === undefined ? null : g.carHomes.carOf(key);
    if (key !== undefined && (!owner || g.carHomes.isMoving(key))) return null;
    if (key === undefined && !id.startsWith('shop:')) return null;
    const away = owner && g.carHomes.awayOf(owner.town, owner.car.key);
    const at = owner ? away ? g.buildingById(away.at ?? owner.car.home.id) ?? owner.car.home : owner.car.place?.at : g.buildingById(Number(id.split(':')[1]));
    const point = owner && !away ? owner.car.place?.look?.pos ?? owner.car.place?.spot.inside : away?.lot !== undefined ? g.lots.poseOf(away)?.nose : away?.curb ? g.curb.stall(away.curb)?.pos : at?.fp.center;
    if (!point || !at) return null;
    const radius = Math.max(at.fp.w, at.fp.h) + 20;
    const drawing = g.garageLooks([point.x - radius, point.y - radius, point.x + radius, point.y + radius], true).find((x) => x.parkedCar === id);
    if (!drawing) return null;
    for (const town of g.towns) {
      const shop = town.shopParked?.find((s) => owner ? s.car === key : id === `shop:${s.b}:${s.k}`);
      if (shop) {
        const at = town.buildings.find((b) => b.id === shop.b);
        const spot = at && g.shops.lotOf(at)?.spots[shop.k];
        if (at && spot) return { id, look: drawing.look, town: owner?.town ?? town, at, car: owner?.car, spot, remove: () => { const i = town.shopParked?.indexOf(shop) ?? -1; if (i >= 0) town.shopParked!.splice(i, 1); } };
      }
    }
    if (!owner?.car.place || g.carHomes.isMoving(owner.car.key)) return null;
    const { car, town } = owner;
    const place = car.place!;
    if (!away) return { id, look: drawing.look, town, at: place.at, car, spot: place.spot, curb: place.curb, lot: place.lot?.id, stall: place.lot?.stall, pocket: place.kind === 'stall', box: place.box, remove() {} };
    if (away.garage) {
      const box = garageBoxes(at)[away.garage.box];
      if (box) return { id, look: drawing.look, town, at, car, spot: box.spot, box, remove() {} };
    }
    const curb = away.curb ? g.curb.stall(away.curb) : undefined;
    const lot = away.lot === undefined ? undefined : g.lots.get(away.lot)?.lot;
    const gates = lot ? g.lots.spotFor(lot, true) : [];
    const spot = gates.find((s) => !g.garages.isBusy(s.key)) ?? gates[0];
    return { id, look: drawing.look, town, at, car, curb, spot, lot: lot?.id, stall: away.ls, remove() {} };
  }

  private destinations(): Destination[] {
    const g = this.game;
    const key = `${g.layoutRev}:${g.townRev}:${g.roads.net.version}:${g.towns.map((t) => `${t.id}:${t.buildings.length}`).join(',')}`;
    if (this.destinationsCache?.key === key) return this.destinationsCache.list;
    const out: Destination[] = [];
    for (const town of g.towns) {
      for (const b of town.buildings.filter((b) => b.kind === 'com')) for (const spot of g.shops.lotOf(b)?.spots ?? []) out.push({ town, b, spot, pos: spot.spot, shop: true });
      for (const b of town.buildings.filter((b) => b.form === 'garages')) for (const box of garageBoxes(b)) out.push({ town, b, pos: box.center, spot: box.spot, box });
      for (const b of town.buildings.filter((b) => b.kind === 'res')) {
        const lot = yardLotOf(b);
        if (!lot) continue;
        for (const [k, s] of yardSpots(b, lot, CAR_SIZE.l).spots.entries()) {
          if (!s.drive) continue;
          const spot = carSpot(stallKey(b.id, k), b, s.drive, true, '#888888', CAR_SIZE.l);
          out.push({ town, b, spot, pos: spot.spot, pocket: true });
        }
      }
      for (const lot of town.lots ?? []) for (const [stall, s] of lotLayout(lot).stalls.entries()) {
        const b = town.buildings.find((x) => x.kind === 'com') ?? town.buildings[0];
        if (b) out.push({ town, b, pos: s.pos, lot: lot.id, stall });
      }
    }
    this.destinationsCache = { key, list: out };
    return out;
  }

  /** Размещение тестового транспорта: парковочное место либо ближайшая полоса движения. */
  spawn(spec: VehicleSpec, p: Vec): { parked?: string; simId?: number } | string {
    const g = this.game;
    const id = `test:${this.sequence--}`;
    const target = this.destinations().filter((t) => dist(t.pos, p) < 5).sort((a, b) => dist(a.pos, p) - dist(b.pos, p))[0];
    const curb = g.curb.near(p, 5).sort((a, b) => dist(a.pos, p) - dist(b.pos, p))[0];
    if (target || curb) {
      if (spec.length > 9 || spec.width > 4) return 'Этот автомобиль не помещается на легковом парковочном месте';
      if (target) {
        const problem = this.problem(target);
        if (problem) return problem;
        if (target.shop) {
          const k = g.shops.lotOf(target.b)!.spots.indexOf(target.spot!);
          (target.town.shopParked ??= []).push({ b: target.b.id, k, color: spec.color, until: Infinity });
          return { parked: `shop:${target.b.id}:${k}` };
        }
        if (target.pocket) {
          this.register({ id, look: { ...spec, pos: add(target.pos, scale(target.spot!.d.dir, spec.length / 2)), dir: target.spot!.d.dir }, town: target.town, at: target.b, spot: target.spot, pocket: true, remove() {} });
          return { parked: id };
        }
        if (target.box) {
          this.register({ id, look: { ...spec, pos: add(target.box.center, scale(target.box.dir, spec.length / 2)), dir: target.box.dir }, town: target.town, at: target.b, spot: target.spot, box: target.box, remove() {} });
          return { parked: id };
        }
        const lot = g.lots.get(target.lot!)!.lot;
        const stall = lotLayout(lot).stalls[target.stall!];
        const occupant = this.sequence--;
        g.lots.park(lot.id, target.stall!, occupant, true);
        this.register({ id, look: { ...spec, pos: stall.nose, dir: stall.dir }, at: target.b, town: target.town, lot: lot.id, stall: target.stall, spot: g.lots.spotFor(lot, true)[0], occupant, remove() {} });
        return { parked: id };
      }
      if (g.curb.occupied(curb.key)) return 'Это место занято';
      const town = g.towns.slice().sort((a, b) => dist(a.center, p) - dist(b.center, p))[0];
      if (!town?.buildings.length) return 'Рядом нет места назначения';
      const occupant = this.sequence--;
      g.curb.park(curb.key, occupant, true);
      this.register({ id, look: { ...spec, pos: add(curb.pos, scale(curb.dir, spec.length / 2)), dir: curb.dir }, at: town.buildings[0], town, curb, occupant, remove() {} });
      return { parked: id };
    }
    const corridor = g.roads.net.corridorNear(p, 24);
    if (!corridor) return 'Кликните по полосе движения или парковочному месту';
    const axis = corridor.lut.closest(p).s;
    const choices = g.roads.graph.corridorLinks(corridor.id).flatMap((link) => link.lanes.map((lane) => {
      const u = link.flow > 0 ? axis - link.s0 : link.s1 - axis;
      return { link, lane, u, distance: dist(g.roads.graph.lanePose(lane, u).pos, p) };
    })).sort((a, b) => a.distance - b.distance);
    const at = choices[0];
    if (!at || at.distance > 4 || at.u < spec.length / 2 + 2 || at.u > at.lane.length - spec.length / 2 - 2) return 'Выберите место на полосе дальше от перекрёстка';
    const nose = at.u + spec.length / 2;
    if (!g.traffic.clearToJoin(at.lane.id, nose - spec.length - 1, nose + 1)) return 'На этом месте уже есть транспорт';
    const sim = g.traffic.placeOnLane({ ...spec, targetNode: at.link.toNode!, endLink: at.link.id }, at.lane.id, nose);
    if (!sim) return 'Не удалось поставить автомобиль на полосу';
    return { simId: sim.id };
  }

  sendVehicle(simId: number, p: Vec): string | null {
    const g = this.game;
    const sim = g.traffic.vehicles.get(simId);
    if (!sim) return 'Машина уже завершила поездку';
    const lane = g.traffic.currentLane(sim);
    const link = lane && g.roads.graph.links.get(lane.link);
    if (!link) return 'Дождитесь завершения поворота';
    const b = g.towns.flatMap((t) => t.buildings)[0];
    const town = g.towns[0];
    const owner = g.carHomes.carOfSim(sim.id);
    const fleet = owner && g.carHomes.carOf(owner.car);
    const source: ParkedCarSource | null = b && town ? { id: `sim:${simId}`, look: sim, at: b, town: fleet?.town ?? town, car: fleet?.car, remove() {} } : null;
    const target = source && this.clicked(source, p);
    if (!target) {
      const corridor = g.roads.net.corridorNear(p, 24);
      const axis = corridor?.lut.closest(p).s ?? 0;
      const choices = corridor ? g.roads.graph.corridorLinks(corridor.id).flatMap((dest) => dest.lanes.map((lane) => {
        const u = dest.flow > 0 ? axis - dest.s0 : dest.s1 - axis;
        return { dest, lane, u, pose: g.roads.graph.lanePose(lane, u) };
      })).sort((a, b) => dist(a.pose.pos, p) - dist(b.pose.pos, p)) : [];
      const at = choices[0];
      const route = at && findLaneRoute(g.roads.graph, [link], at.dest.toNode!, at.dest.id);
      if (!at || dist(at.pose.pos, p) > 4 || !route || (route.length === 1 && at.u + sim.length / 2 <= sim.s) || !g.traffic.redirect(sim, at.dest.toNode!, route)) return 'Нет маршрута к указанному месту на дороге';
      g.garages.forget(sim.id); g.curb.forget(sim.id); g.traffic.release(sim);
      sim.endLink = at.dest.id;
      if (at.lane.index === 0) sim.endLeft = true;
      else delete sim.endLeft;
      this.roadGoals.set(sim.id, { link: at.dest.id, u: Math.min(at.lane.length - 1, at.u + sim.length / 2), goal: at.pose.pos, dir: at.pose.dir, holding: false });
      return null;
    }
    if (sim.length > 9 || sim.width > 4) return 'Этот автомобиль не помещается на легковом парковочном месте';
    const problem = this.problem(target);
    if (problem) return problem;
    return this.drive(source!, target, sim);
  }

  private home(s: ParkedCarSource): Destination | null {
    const p = s.car?.place;
    const pos = p?.box?.center ?? p?.curb?.pos ?? (p?.lot ? lotLayout(this.game.lots.get(p.lot.id)!.lot).stalls[p.lot.stall]?.pos : null) ?? (p?.look ? add(p.look.pos, scale(p.look.dir, -CAR_SIZE.l / 2)) : p?.spot.spot);
    return p && pos ? { town: s.town, b: p.at, pos, spot: p.spot, curb: p.curb, lot: p.lot?.id, stall: p.lot?.stall, box: p.box, home: true } : null;
  }

  targets(id?: string): { pos: Vec; dir: Vec; free: boolean }[] {
    const list = [...this.destinations()];
    const s = id && this.source(id);
    const home = s && this.home(s);
    if (home) list.push(home);
    for (const town of this.game.towns) for (const curb of this.game.curb.near(town.center, town.radius + 250)) list.push({ town, b: town.buildings[0], pos: curb.pos, curb });
    return list.map((t) => ({ pos: t.pos, dir: t.box?.dir ?? t.curb?.dir ?? t.spot?.d.dir ?? lotLayout(this.game.lots.get(t.lot!)!.lot).stalls[t.stall!].dir, free: !this.problem(t) }));
  }

  placementPreview(spec: VehicleSpec, p: Vec): { look: VehicleLook; ok: boolean; label: string } {
    const g = this.game;
    const target = this.destinations().filter((t) => dist(t.pos, p) < 5).sort((a, b) => dist(a.pos, p) - dist(b.pos, p))[0];
    const curb = g.curb.near(p, 5).sort((a, b) => dist(a.pos, p) - dist(b.pos, p))[0];
    if (target || curb) {
      const center = target?.pos ?? curb.pos;
      const dir = target ? target.box?.dir ?? target.spot?.d.dir ?? lotLayout(g.lots.get(target.lot!)!.lot).stalls[target.stall!].dir : curb.dir;
      const problem = spec.length > 9 || spec.width > 4 ? 'Автомобиль не помещается на этом месте' : target ? this.problem(target) : g.curb.occupied(curb.key) ? 'Это место занято' : null;
      return { look: { ...spec, pos: add(center, scale(dir, spec.length / 2)), dir }, ok: !problem, label: problem ?? 'Поставить на это парковочное место' };
    }
    const corridor = g.roads.net.corridorNear(p, 24);
    const axis = corridor?.lut.closest(p).s ?? 0;
    const choices = corridor ? g.roads.graph.corridorLinks(corridor.id).flatMap((link) => link.lanes.map((lane) => {
      const u = link.flow > 0 ? axis - link.s0 : link.s1 - axis;
      return { lane, u, pose: g.roads.graph.lanePose(lane, u) };
    })).sort((a, b) => dist(a.pose.pos, p) - dist(b.pose.pos, p)) : [];
    const at = choices[0];
    const inside = at && dist(at.pose.pos, p) <= 4 && at.u > spec.length / 2 + 2 && at.u < at.lane.length - spec.length / 2 - 2;
    const free = inside && g.traffic.clearToJoin(at.lane.id, at.u - spec.length / 2 - 1, at.u + spec.length / 2 + 1);
    const dir = at?.pose.dir ?? { x: 1, y: 0 };
    return { look: { ...spec, pos: add(at?.pose.pos ?? p, scale(dir, spec.length / 2)), dir }, ok: !!free, label: !inside ? 'Кликните по полосе дальше от перекрёстка' : free ? 'Поставить автомобиль на эту полосу' : 'На этом месте уже есть транспорт' };
  }

  /** Та же геометрия полос, что у линии выбранного автомобиля; до конкретного места. */
  preview(id: string, p: Vec): { pts: Vec[]; goal: Vec; dir: Vec; ok: boolean } | null {
    const g = this.game;
    const sim = id.startsWith('sim:') ? g.traffic.vehicles.get(Number(id.slice(4))) : undefined;
    const source = this.source(id);
    const dummy: ParkedCarSource | null = sim && g.towns[0]?.buildings[0] ? { id, town: g.towns[0], at: g.towns[0].buildings[0], look: sim, remove() {} } : null;
    const s = source ?? dummy;
    const t = s && this.clicked(s, p);
    if (!s || !t) return sim ? this.previewRoad(sim, p) : null;
    const lane = sim && g.traffic.currentLane(sim);
    const start = s.curb && g.curb.slotOf(s.curb);
    const starts = (lane ? [g.roads.graph.links.get(lane.link)] : start ? [start.link] : s.spot ? [g.garages.slotOf(s.spot)?.link, g.garages.leftSlotOf(s.spot)?.link] : []).filter((x): x is GLink => !!x);
    let spot = t.spot;
    if (t.lot !== undefined && !t.home) {
      const lot = g.lots.get(t.lot)?.lot;
      spot = lot && g.lots.spotFor(lot, false).find((x) => !!g.garages.wayFrom(starts, x));
    }
    const way = spot && g.garages.wayFrom(starts, spot, sim?.s ?? 0);
    const curb = t.curb && g.curb.slotOf(t.curb);
    const link = curb?.link ?? way?.slot.link;
    const route = link && findLaneRoute(g.roads.graph, starts, link.toNode!, link.id);
    const center = add(s.look.pos, scale(s.look.dir, -s.look.length / 2));
    const aim = curb?.link ? t.curb!.pos : way?.slot.pos ?? t.pos;
    const pts = route ? g.roads.routePolyline(route) : [];
    const nearest = (p: Vec, from = 0) => {
      let best = from;
      for (let i = from; i < pts.length; i++) if (dist(pts[i], p) < dist(pts[best], p)) best = i;
      return best;
    };
    const first = pts.length ? nearest(center) : 0;
    const last = pts.length ? nearest(aim, first) : 0;
    const prefix = s.box ? s.box.exit[0].pts : [center];
    const tail = t.box ? path(t.box.via, 4.5, false, 5).pts : [t.pos];
    return { pts: route ? [...prefix, ...pts.slice(first, last + 1), aim, ...tail] : [], goal: t.pos, dir: t.box?.dir ?? t.curb?.dir ?? spot?.d.dir ?? { x: 1, y: 0 }, ok: !!route && !this.problem(t) };
  }

  private previewRoad(sim: Vehicle, p: Vec): { pts: Vec[]; goal: Vec; dir: Vec; ok: boolean } | null {
    const g = this.game;
    const current = g.traffic.currentLane(sim);
    const from = current && g.roads.graph.links.get(current.link);
    const corridor = g.roads.net.corridorNear(p, 24);
    if (!from || !corridor) return null;
    const axis = corridor.lut.closest(p).s;
    const choices = g.roads.graph.corridorLinks(corridor.id).flatMap((link) => link.lanes.map((lane) => {
      const u = link.flow > 0 ? axis - link.s0 : link.s1 - axis;
      return { link, u, pose: g.roads.graph.lanePose(lane, u) };
    })).sort((a, b) => dist(a.pose.pos, p) - dist(b.pose.pos, p));
    const at = choices[0];
    if (!at || dist(at.pose.pos, p) > 4) return null;
    const route = findLaneRoute(g.roads.graph, [from], at.link.toNode!, at.link.id);
    const valid = !!route && !(route.length === 1 && at.u + sim.length / 2 <= sim.s);
    const path = route ? g.roads.routePolyline(route) : [];
    const center = add(sim.pos, scale(sim.dir, -sim.length / 2));
    const nearest = (p: Vec, from = 0) => {
      let best = from;
      for (let i = from; i < path.length; i++) if (dist(path[i], p) < dist(path[best], p)) best = i;
      return best;
    };
    const first = path.length ? nearest(center) : 0;
    const last = path.length ? nearest(at.pose.pos, first) : 0;
    return { pts: valid ? [center, ...path.slice(first, last + 1), at.pose.pos] : [], goal: at.pose.pos, dir: at.pose.dir, ok: valid };
  }

  private clicked(s: ParkedCarSource, p: Vec): Destination | null {
    const homes = this.home(s);
    const candidates = [...this.destinations()];
    if (homes) candidates.unshift(homes);
    for (const curb of this.game.curb.near(p, 5)) candidates.push({ town: s.town, b: this.game.buildingById(s.car?.home.id ?? s.at.id) ?? s.at, pos: curb.pos, curb });
    return candidates.filter((x) => dist(x.pos, p) < 5).sort((a, b) => dist(a.pos, p) - dist(b.pos, p))[0] ?? null;
  }

  targetLabel(id: string, p: Vec): string {
    if (id.startsWith('sim:')) return 'Кликните по парковочному месту или дороге · Esc — отмена';
    const s = this.source(id);
    const t = s && this.clicked(s, p);
    return t ? this.problem(t) ?? (t.box ? `Поехать в гараж №${t.box.index + 1}` : 'Поехать на это парковочное место') : 'Кликните по парковочному месту или боксу · Esc — отмена';
  }

  send(id: string, p?: Vec): string | null {
    if (id.startsWith('sim:') && p) return this.sendVehicle(Number(id.slice(4)), p);
    const queued = this.queued.get(id);
    if (queued) { queued.release(); this.queued.delete(id); this.commands.delete(id); }
    const s = this.source(id);
    if (!s) return 'Машина уже покинула это место';
    let choices: Destination[];
    if (p) {
      const target = this.clicked(s, p);
      if (!target) return 'Кликните по конкретному парковочному месту';
      choices = [target];
    } else {
      const home = this.home(s);
      choices = home && !this.game.carHomes.isHome(s.town, s.car!.key) ? [home] : this.destinations().sort((a, b) => dist(a.pos, s.look.pos) - dist(b.pos, s.look.pos));
    }
    let problem = 'Нет доступного места назначения';
    for (const target of choices) {
      problem = this.problem(target) ?? this.drive(s, target) ?? '';
      if (!problem) return null;
    }
    return problem;
  }

  private problem(t: Destination): string | null {
    const g = this.game;
    if (t.home) return g.garages.isBusy(t.spot!.key) ? 'У дома выполняется манёвр' : null;
    if (t.pocket || t.box) {
      if (this.reservedPlaces.has(t.spot!.key)) return 'К этому месту уже едет автомобиль';
      const fleet = g.carHomes.fleet(t.town);
      let assigned = this.assignedPlaces.get(fleet);
      if (!assigned) { assigned = new Set(fleet.cars.flatMap((c) => c.place ? [c.place.spot.key] : [])); this.assignedPlaces.set(fleet, assigned); }
      const visitors = g.towns.some((town) => town.cars?.some((c) => c.garage?.building === t.b.id && c.garage.box === t.box?.index));
      return visitors || g.garages.isBusy(t.spot!.key) || assigned.has(t.spot!.key) || [...this.extras.values()].some((s) => s.spot?.key === t.spot!.key && (!this.commands.has(s.id) || this.queued.has(s.id))) ? 'Это место занято или закреплено за машиной дома' : null;
    }
    if (t.curb) return g.curb.occupied(t.curb.key) ? 'Это место занято' : null;
    if (t.lot !== undefined) return g.lots.freeStall(t.lot, t.stall!) ? null : 'Это место занято';
    const k = t.spot && g.shops.lotOf(t.b)?.spots.indexOf(t.spot);
    return k !== undefined && k >= 0 && g.shops.freeSpot(t.town, t.b, k) ? null : 'Это место занято';
  }

  private drive(s: ParkedCarSource, t: Destination, existing?: Vehicle): string | null {
    const g = this.game;
    const home = s.car && g.carHomes.isHome(s.town, s.car.key);
    const curbSlot = s.curb && g.curb.slotOf(s.curb);
    const lane = existing && g.traffic.currentLane(existing);
    const starts = (lane ? [g.roads.graph.links.get(lane.link)] : curbSlot ? [curbSlot.link] : s.spot ? [g.garages.slotOf(s.spot)?.link, g.garages.leftSlotOf(s.spot)?.link] : []).filter((l): l is GLink => !!l);
    if (!starts.length) return 'Нет выезда на дорогу';
    let spot = t.spot;
    if (t.lot !== undefined && !t.home) {
      const lot = g.lots.get(t.lot)?.lot;
      spot = lot && g.lots.spotFor(lot, false).find((x) => !!g.garages.wayFrom(starts, x));
    }
    const curb = t.curb && g.curb.slotOf(t.curb);
    const way = spot && !curb ? g.garages.wayFrom(starts, spot) : null;
    const slot: GarageSlot | undefined = way?.slot;
    const link = curb?.link ?? slot?.link;
    if (!link || !findLaneRoute(g.roads.graph, starts, link.toNode!, link.id)) return 'Нет маршрута к этому месту';
    if (!t.curb && !spot) return 'Нет въезда на парковку';
    if (!existing && this.blocked(s)) {
      const token = this.sequence--;
      const releasePlace = this.reservePlace(t);
      if (t.shop && spot) g.shops.reserveSpot(spot.key);
      if (t.lot !== undefined && !t.home) g.lots.hold(t.lot, t.stall!, token);
      const waiting: Command = { source: s, target: t, state: 'Ждёт выезда', preview: this.preview(s.id, t.pos) ?? undefined, release: () => { releasePlace(); if (t.shop && spot) g.shops.releaseSpot(spot.key); if (t.lot !== undefined && !t.home) g.lots.release(t.lot, t.stall!, token); } };
      this.commands.set(s.id, waiting); this.queued.set(s.id, waiting);
      return null;
    }
    const token = s.car?.key ?? this.sequence--;
    const releasePlace = this.reservePlace(t);
    const release = () => {
      releasePlace();
      if (t.shop && spot) g.shops.releaseSpot(spot.key);
      if (t.lot !== undefined && !t.home) g.lots.release(t.lot, t.stall!, token);
    };
    if (t.shop && spot) g.shops.reserveSpot(spot.key);
    if (t.lot !== undefined && !t.home) g.lots.hold(t.lot, t.stall!, token);
    const command: Command = { source: s, target: t, state: 'Выезжает', release, preview: this.preview(s.id, t.pos) ?? undefined };
    this.commands.set(s.id, command);
    const retry = () => {
      command.state = 'Ждёт выезда';
      this.queued.set(s.id, command);
      if (s.car) g.carHomes.manualMoving(s.car.key, false);
    };
    const arrived = () => {
      release();
      command.state = 'Припарковалась';
      const place: Partial<TownCar> = {};
      if (t.shop) {
        const k = g.shops.lotOf(t.b)!.spots.indexOf(spot!);
        (t.town.shopParked ??= []).push({ b: t.b.id, k, color: s.look.color, until: Infinity, ...(s.car ? { car: s.car.key } : {}) });
        place.spot = spot!.key;
        if (!s.car) command.arrivalId = `shop:${t.b.id}:${k}`;
      }
      if (t.lot !== undefined && !t.home) { g.lots.park(t.lot, t.stall!, token, !s.car); place.lot = t.lot; place.ls = t.stall; }
      if (t.curb && !t.home) { g.curb.park(t.curb.key, token, !s.car); place.curb = t.curb.key; place.cp = [t.curb.pos.x, t.curb.pos.y]; }
      if (t.box && !t.home) place.garage = { building: t.b.id, box: t.box.index };
      if (s.car) g.carHomes.manualPark(s.town, s.car, t.b, place, t.home);
      if (command.sim) this.arrivals.set(command.sim.id, s.car ? `car:${s.car.key}` : t.shop ? command.arrivalId! : s.id);
      // Машины вне парка жителей сохраняют свой кузов и могут получить следующую команду.
      if ((!s.car && !t.shop) || t.pocket) {
        const pose = t.box ? { pos: add(t.box.center, scale(t.box.dir, s.look.length / 2)), dir: t.box.dir } : t.pocket ? { pos: add(t.pos, scale(t.spot!.d.dir, s.look.length / 2)), dir: t.spot!.d.dir } : t.curb ? { pos: add(t.curb.pos, scale(t.curb.dir, s.look.length / 2)), dir: t.curb.dir } : lotLayout(g.lots.get(t.lot!)!.lot).stalls[t.stall!];
        const look = { ...s.look, pos: 'nose' in pose ? pose.nose : pose.pos, dir: pose.dir };
        this.commands.delete(s.id);
        this.register({ ...s, look, at: t.b, town: s.car ? s.town : t.town, spot, curb: t.curb, lot: t.lot, stall: t.stall, pocket: t.pocket, box: t.box, occupant: token, remove() {} });
      }
    };
    const missed = () => {
      release();
      command.state = 'Не удалось припарковаться';
      if (command.sim && g.traffic.vehicles.has(command.sim.id)) g.traffic.holdAfter(command.sim, 0);
      g.notify('Не удалось занять выбранное место');
    };
    const then = (sim: Vehicle) => {
      command.sim = sim;
      command.state = 'В пути';
      const hooks = { arrived, missed };
      command.arrivalHooks = hooks;
      if (t.curb) g.curb.toCurb(sim, link.id, () => [t.curb!], hooks, token);
      else {
        // Фактическая точка слияния может быть уже дальше въезда (особенно при поездке между местами одной площадки).
        const lane = g.traffic.currentLane(sim);
        const from = lane && g.roads.graph.links.get(lane.link);
        let approach = from && g.garages.wayFrom([from], spot!, sim.s);
        if (!approach && from) {
          const variants = [g.garages.slotOf(spot!), g.garages.leftSlotOf(spot!)].filter((s): s is GarageSlot => !!s);
          const options = variants.flatMap((s) => from.lanes.flatMap((l) => (g.roads.graph.movesFrom.get(l.id) ?? []).flatMap((m) => {
            const next = g.roads.graph.links.get(m.outLink)!;
            const route = findLaneRoute(g.roads.graph, [next], s.link.toNode!, s.link.id);
            return route ? [{ slot: s, route: [from.id, ...route], cost: route.length }] : [];
          })));
          approach = options.sort((a, b) => a.route.length - b.route.length)[0];
        }
        if (!approach || !g.traffic.redirect(sim, approach.slot.link.toNode!, approach.route)) { missed(); return; }
        sim.endLink = approach.slot.link.id;
        g.garages.toStall(sim, spot!, t.town, approach.slot, hooks, () => [spot!], t.box ? () => t.box!.via : t.lot !== undefined ? () => g.lots.route(spot!, t.stall!) : undefined, true);
      }
    };
    if (existing) {
      const route = findLaneRoute(g.roads.graph, starts, link.toNode!, link.id);
      if (!g.traffic.redirect(existing, link.toNode!, route)) { release(); this.commands.delete(s.id); return 'Нет маршрута к этому месту'; }
      this.roadGoals.delete(existing.id);
      g.garages.forget(existing.id); g.curb.forget(existing.id); g.traffic.release(existing);
      if (s.car) g.carHomes.manualJoined(s.town, s.car, t.b, existing);
      existing.endLink = link.id;
      then(existing);
      return null;
    }
    if (home) {
      const parked = g.garageLooks([s.look.pos.x - 40, s.look.pos.y - 40, s.look.pos.x + 40, s.look.pos.y + 40], true).filter((x) => x.parkedCar !== s.id).map((x) => ({ pos: x.look.pos, dir: x.look.dir }));
      g.carHomes.depart({ kind: 'out', town: s.town, car: s.car! }, t.b, { target: link.toNode!, endLink: link.id, to: spot, then, parked, onStayed: retry });
      return null;
    }
    let exit: ReturnType<Game['lots']['exit']> = null;
    if (s.lot !== undefined && s.spot) exit = g.lots.exit(s.spot, s.stall!, token);
    const joined = (sim: Vehicle) => {
      exit?.release();
      s.remove();
      this.extras.delete(s.id);
      if (s.curb) g.curb.unpark(s.curb.key, s.car?.key ?? s.occupant ?? token);
      if (s.lot !== undefined) g.lots.unpark(s.lot, s.stall!, s.car?.key ?? s.occupant ?? token);
      if (s.car) g.carHomes.manualJoined(s.town, s.car, t.b, sim);
    };
    const stayed = () => { exit?.release(); retry(); };
    if (s.car) g.carHomes.manualMoving(s.car.key, true);
    if (s.curb) {
      if (!g.curb.leave(s.curb, link.toNode!, { from: s.at, to: t.b }, { color: s.look.color, car: s.car?.key ?? token, endLink: link.id, hooks: { joined, stayed }, then })) stayed();
    } else {
      const parked = s.pocket ? g.garageLooks([s.look.pos.x - 40, s.look.pos.y - 40, s.look.pos.x + 40, s.look.pos.y + 40], true).filter((x) => x.parkedCar !== s.id).map((x) => ({ pos: x.look.pos, dir: x.look.dir })) : [];
      const pocket = s.pocket ? pocketExit(s.spot!, parked, s.look.length, s.look.width) : null;
      g.garages.leave(s.spot!, s.town, link.toNode!, { from: s.at, to: t.b }, { color: s.look.color, endLink: link.id, to: spot, via: s.box?.via ?? (s.lot === undefined ? undefined : g.lots.route(s.spot!, s.stall!)), exit: s.box?.exit ?? exit?.legs ?? pocket, hooks: { joined, stayed, finished: () => exit?.release() }, then });
    }
    return null;
  }

  private blocked(s: ParkedCarSource): boolean {
    const g = this.game;
    return !!(s.spot && g.garages.isBusy(s.spot.key)) || !!((s.pocket || s.box) && g.garages.moves.some((m) => m.home.b.id === s.at.id)) || !!(s.spot && g.shops.lotOf(s.at)?.spots.includes(s.spot) && !g.shops.canDepartSpot(s.at, s.spot)) || !!(s.lot !== undefined && g.lots.exiting(s.lot)) || !!(s.car && g.carHomes.isHome(s.town, s.car.key) && !g.carHomes.canDepart(s.town, s.car)) || !!(s.curb && !g.curb.canLeave(s.curb));
  }

  private reservePlace(t: Destination): () => void {
    if (!t.pocket && !t.box) return () => {};
    const claim = {};
    this.reservedPlaces.set(t.spot!.key, claim);
    return () => { if (this.reservedPlaces.get(t.spot!.key) === claim) this.reservedPlaces.delete(t.spot!.key); };
  }

  private arrivalMove(c: Command): { run: Run; sim?: Vehicle } | null {
    if (!c.arrivalHooks) return null;
    const move = [...this.game.garages.moves, ...this.game.curb.moves].find((m) => m.kind === 'in' && m.hooks === c.arrivalHooks);
    return move?.run ? { run: move.run, sim: move.sim } : null;
  }
}

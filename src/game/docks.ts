import { add, dist, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import type { GLane, LaneGraph } from '../lanes/graph';
import type { LaneNet } from '../lanes/model';
import { findLaneRoute } from '../lanes/routing';
import type { LaneTraffic } from '../lanes/traffic';
import { steerBase } from '../sim/body';
import type { Vehicle, VehicleSpec } from '../sim/vehicle';
import type { TownBuilding } from '../world/entities';
import { lotFrame, type Driveway } from '../world/houseAccess';
import { DOCK_TRUCK, dockDriveway, dockYardOf, RAMP_GAP, type DockYard } from '../world/shopLots';
import { laneSlot, type GarageSlot } from './garages';
import { bezier, legPose, straight, type Leg } from './lotMoves';

/**
 * Грузовик у получателя (docs/RETAIL.md, «Заезд во двор»; world/retail.ts): маршрут кончается связью у его двора
 * (Vehicle.endLink), грузовик замедляется, с поворотником встаёт напротив проезда (holdAfter) и сворачивает в него
 * передом — пока кузов над полосой, он в потоке (стоит, его объезжают), дальше — во дворе, только рисунок. Двор
 * 'turn' (world/shopLots.DockYard): по проезду за здание, поворот, задом к рампе на задней стене; выгрузка; разворот к
 * проезду, передом к бордюру, ждёт настоящего просвета (LaneTraffic.clearToJoin) и выезжает направо в поток. Двор
 * 'back' (мелкий, рампа у торца, склад): передом по проезду до рампы, выезд задним ходом на полосу, как из гаража.
 *
 * Рампа одна: второй грузовик к ней не едет (game.ts: ждёт на прошлой остановке, потом пропускает получателя). Двор
 * общий с машинами покупателей на стоянке (game/shopParking.ts): пока одна из них на манёвре, грузовик не начинает
 * свой, а пока грузовик на манёвре во дворе — они ждут (DockHost.lotBusy, Docks.yardBusy).
 *
 * Манёвры не сохраняются (как у гаражей): грузовик во дворе в сохранении — на остановке; после загрузки он встаёт у
 * рампы и выезжает от неё.
 */
export const DOCK = {
  /** Скорости манёвра, м/с игры: с полосы в проезд, по двору передом и задом, на полосу; разгон и торможение. */
  speed: { roadIn: 4, yardIn: 3, yardBack: 2, roadOut: 3.5, accel: 2.5, brake: 3.5 },
  /** За столько метров до проезда грузовик сбрасывает скорость до slow (м/с игры) — остановится напротив. */
  slowAt: 80,
  slow: 7,
  /** Поворотник — за столько метров. */
  blinkAt: 50,
  /** Мягкое торможение к проезду, м/с² игры: позже уже не остановиться — проезжает мимо. */
  hold: 6,
  /** У бордюра перед выездом — смотрит по сторонам хотя бы столько, с; встав на полосу — столько до того, как тронуться. */
  look: 0.8,
  pause: 0.5,
} as const;

/** Место манёвра на полосе — не ближе стольких метров к её концам (как у гаражей). */
const END_ROOM = 10;

/** Где грузовик выезжает передом на полосу направо (двор 'turn'): полоса, середина кузова, что заметает, поза. */
interface OutSlot {
  lane: GLane;
  mid: number;
  zone: [number, number];
  pos: Vec;
  f: Vec;
}

/** Двор получателя для грузовика длины L: заезд, где сворачивать и выезжать, отрезки манёвра во дворе. */
export interface DockGeo {
  b: TownBuilding;
  fp: TownBuilding['fp'];
  yard: DockYard;
  d: Driveway;
  L: number;
  W: number;
  /** Середина кузова у бордюра: корма у полотна (въехал передом) или нос у полотна (ждёт выезда). */
  curbSide: Vec;
  in: GarageSlot | null;
  /** Выезд на полосу: 'turn' — передом направо дальше по ходу; 'back' — задом, как въезжал (то же место, что in). */
  out: OutSlot | null;
  /** Середина кузова и курс у рампы. */
  ramp: { c: Vec; h: Vec };
  /** Двор: от бордюра до рампы и от рампы до бордюра (у полотна — нос к улице или корма к ней). */
  inLegs: Leg[];
  outLegs: Leg[];
}

/** Что игра даёт дворам. */
export interface DockHost {
  readonly traffic: LaneTraffic;
  readonly graph: LaneGraph;
  readonly net: LaneNet;
  /** Машина покупателя на манёвре у этого дома (стоянка): двор занят. */
  lotBusy(b: number): boolean;
  /** Грузовик id сошёл с полосы во двор — в потоке его больше нет (sim снят). */
  gone(id: number, sim: Vehicle): void;
  /** Грузовик id встал к рампе. */
  arrived(id: number): void;
  /** Грузовик id выезжает: уже в потоке (sim, стоит, пока не встанет на полосу носом по ходу). */
  joined(id: number, sim: Vehicle): void;
}

/** Грузовик в потоке едет ко двору: дом, длина, свой предел скорости (вернуть, если проедет мимо). */
interface Homing {
  id: number;
  b: TownBuilding;
  maxSpeed: number;
  /** Уже у проезда (сбросил скорость): рампа — за ним, другому грузовику туда не сворачивать. */
  close?: boolean;
}

/** Грузовик на манёвре: отрезки по порядку, где на них, машина в потоке (пока кузов над полосой). */
interface Move {
  id: number;
  geo: DockGeo;
  kind: 'in' | 'out';
  phase: 'legs' | 'wait' | 'join' | 'pause';
  legs: Leg[];
  i: number;
  s: number;
  v: number;
  wait: number;
  sim?: Vehicle;
  /** Въезд: отрезок на полосе — первый; дошёл до конца его — сошёл с полосы. */
  road: boolean;
  /** Выезд: кузов, куда едет, последняя связь (едет к следующему получателю). */
  spec?: VehicleSpec;
  target?: number;
  endLink?: number;
  blink: -1 | 0 | 1;
}

export class Docks {
  private geos = new Map<string, DockGeo | null>();
  private geoGraph: LaneGraph | null = null;
  private homing = new Map<number, Homing>();
  private moves = new Map<number, Move>();
  /** Стоят у рампы (выгружаются): грузовик → двор. */
  private parked = new Map<number, DockGeo>();

  constructor(private host: DockHost) {}

  /** Двор дома b для грузовика длины L и ширины W на нынешнем графе; двора нет или к нему не подъехать — null. */
  geoOf(b: TownBuilding, L: number = DOCK_TRUCK.l, W: number = DOCK_TRUCK.w): DockGeo | null {
    const g = this.host.graph;
    if (this.geoGraph !== g) {
      this.geos.clear();
      this.geoGraph = g;
    }
    const key = `${b.id}:${L}:${W}`;
    const hit = this.geos.get(key);
    if (hit !== undefined && (hit === null || (hit.b === b && hit.fp === b.fp))) return hit;
    const geo = this.compute(b, L, W, g);
    this.geos.set(key, geo);
    return geo;
  }

  /** Можно ли грузовику длины L заехать во двор и выехать. */
  reachable(b: TownBuilding, L: number = DOCK_TRUCK.l, W: number = DOCK_TRUCK.w): boolean {
    const geo = this.geoOf(b, L, W);
    return !!geo?.in && !!geo.out;
  }

  private compute(b: TownBuilding, L: number, W: number, g: LaneGraph): DockGeo | null {
    const yard = dockYardOf(b);
    const d = dockDriveway(b);
    if (!yard || !d) return null;
    const at = lotFrame(b);
    const o = at(0, 0);
    const X = sub(at(1, 0), o);
    const Y = d.dir;
    const curbSide = add(d.curb, scale(Y, L / 2 + 0.3));
    const slot = laneSlot(g, this.host.net, d, curbSide, L, W);
    const sp = DOCK.speed;
    let ramp: { c: Vec; h: Vec };
    let inLegs: Leg[];
    let outLegs: Leg[];
    let out: OutSlot | null = null;
    if (yard.kind === 'turn') {
      const s = yard.side;
      const R = DOCK_TRUCK.r;
      const k = 0.55 * R;
      const fy = yard.wall + L / 2 + RAMP_GAP;
      const F = at(yard.rx, fy);
      const E = at(yard.drive.x, fy);
      const P = at(yard.drive.x - s * R, fy + R);
      const Q = at(yard.rx - s * R, fy + R);
      ramp = { c: F, h: Y };
      inLegs = [straight(curbSide, E, false, sp.yardIn), bezier(E, add(E, scale(Y, k)), add(P, scale(X, s * k)), P, false, sp.yardIn)];
      if (dist(P, Q) > 0.3) inLegs.push(straight(P, Q, false, sp.yardIn));
      inLegs.push(bezier(Q, add(Q, scale(X, s * k)), add(F, scale(Y, k)), F, true, sp.yardBack));
      // Разворот от рампы к проезду: петля в глубине двора, не за забор.
      const ku = Math.max(2, (b.fp.h / 2 - 0.6 - W / 2 - fy) / 0.75);
      outLegs = [bezier(F, add(F, scale(Y, ku)), add(E, scale(Y, ku)), E, false, sp.yardIn), straight(E, curbSide, false, sp.yardIn)];
      if (slot) {
        // Выезд направо, дальше по ходу полосы: зеркально повороту с неё.
        const rel = sub(curbSide, slot.pos);
        const along = dot(rel, slot.f);
        const lat = Math.abs(dot(rel, rightNormal(slot.f)));
        const mid = slot.mid + along + lat;
        const zone: [number, number] = [slot.mid + along - W / 2 - 1, mid + L / 2 + 0.5];
        if (zone[0] >= END_ROOM && zone[1] <= slot.lane.length - END_ROOM) {
          const p = g.lanePose(slot.lane, mid);
          out = { lane: slot.lane, mid, zone, pos: p.pos, f: p.dir };
        }
      }
    } else {
      const F = at(yard.drive.x, yard.drive.y1 - L / 2 - 0.4);
      ramp = { c: F, h: Y };
      inLegs = [straight(curbSide, F, false, sp.yardIn)];
      outLegs = [straight(F, curbSide, true, sp.yardBack)];
      if (slot) out = { lane: slot.lane, mid: slot.mid, zone: slot.zone, pos: slot.pos, f: slot.f };
    }
    return { b, fp: b.fp, yard, d, L, W, curbSide, in: slot, out, ramp, inLegs, outLegs };
  }

  /** Узел, к которому ведёт маршрут ко двору (за ним по ходу полосы); не подъехать — null. */
  nodeOf(b: TownBuilding, L?: number): number | null {
    const geo = this.geoOf(b, L);
    return geo?.in && geo.out ? geo.in.link.toNode : null;
  }

  /** Маршрут от узла from ко двору дома b: последняя связь — та, с которой сворачивать. Не доехать — null. */
  route(from: number, b: TownBuilding, L?: number, W?: number): number[] | null {
    const geo = this.geoOf(b, L, W);
    const slot = geo?.out ? geo.in : null;
    if (!slot || slot.link.toNode === null) return null;
    const g = this.host.graph;
    return findLaneRoute(g, g.outLinks.get(from) ?? [], slot.link.toNode, slot.link.id);
  }

  /** Маршрут ко двору оттуда, где машина sim сейчас (не с её связи — она уже на ней: в объезд квартала). */
  routeFrom(sim: Vehicle, b: TownBuilding): number[] | null {
    const geo = this.geoOf(b, sim.length, sim.width);
    const slot = geo?.out ? geo.in : null;
    const lane = this.host.traffic.currentLane(sim);
    const g = this.host.graph;
    const link = lane && g.links.get(lane.link);
    if (!slot || !link || slot.link.toNode === null) return null;
    return findLaneRoute(g, [link], slot.link.toNode, slot.link.id);
  }

  /** Грузовик id в потоке (sim) едет ко двору дома b: маршрут уже кончается связью у него (route). */
  approach(sim: Vehicle, id: number, b: TownBuilding): boolean {
    const geo = this.geoOf(b, sim.length, sim.width);
    if (!geo?.in || !geo.out) return false;
    sim.endLink = geo.in.link.id;
    this.homing.set(sim.id, { id, b, maxSpeed: sim.maxSpeed });
    return true;
  }

  /** Едет ли машина в потоке ко двору (и чей это грузовик). */
  homingOf(simId: number): number | undefined {
    return this.homing.get(simId)?.id;
  }

  /** Грузовик id на манёвре во дворе или у рампы. */
  inYard(id: number): boolean {
    return this.moves.has(id) || this.parked.has(id);
  }

  /** Грузовик id едет во двор к рампе (ещё не встал к ней). */
  entering(id: number): boolean {
    return this.moves.get(id)?.kind === 'in';
  }

  /** Грузовик id выезжает со двора (ещё не тронулся по полосе). */
  leaving(id: number): boolean {
    return this.moves.get(id)?.kind === 'out';
  }

  /**
   * Рампа дома b занята другим грузовиком (не except): он во дворе — заезжает, стоит у рампы, выезжает — или уже
   * сбросил скорость перед проездом и сейчас свернёт.
   */
  rampBusy(b: number, except?: number): boolean {
    for (const m of this.moves.values()) if (m.id !== except && m.geo.b.id === b) return true;
    for (const [id, geo] of this.parked) if (id !== except && geo.b.id === b) return true;
    for (const h of this.homing.values()) if (h.id !== except && h.b.id === b && h.close) return true;
    return false;
  }

  /** У дома b грузовик на манёвре (не стоит у рампы): машинам покупателей во дворе ждать. */
  yardBusy(b: number): boolean {
    for (const m of this.moves.values()) if (m.geo.b.id === b && m.phase !== 'pause') return true;
    return false;
  }

  /** Сколько грузовиков сейчас во дворах: на манёвре и у рамп. */
  get count(): number {
    return this.moves.size + this.parked.size;
  }

  /**
   * Грузовик id выезжает от рампы (stand — встал к ней после загрузки сохранения: двор дома b) к узлу target, endLink —
   * последняя связь (едет к следующему получателю). Двора больше нет — false.
   */
  leave(id: number, spec: VehicleSpec, target: number, endLink: number | undefined, b?: TownBuilding): boolean {
    if (this.moves.get(id)?.kind === 'out') return true;
    let geo = this.parked.get(id) ?? null;
    if (b) geo = this.geoOf(b, spec.length, spec.width) ?? geo;
    if (!geo?.out) return false;
    this.parked.delete(id);
    this.moves.set(id, { id, geo, kind: 'out', phase: 'legs', legs: geo.outLegs, i: 0, s: 0, v: 0, wait: 0, road: false, spec, target, endLink, blink: 0 });
    return true;
  }

  /** Грузовик id встаёт к рампе дома b сразу (из сохранения: стоял у неё или был во дворе). */
  stand(id: number, b: TownBuilding, L: number, W: number): boolean {
    const geo = this.geoOf(b, L, W);
    if (!geo) return false;
    this.moves.delete(id);
    this.parked.set(id, geo);
    return true;
  }

  /** Грузовика id больше нет (продан, маршрут поменяли): ни манёвра, ни места у рампы. Машину в потоке — отпустить. */
  forget(id: number): void {
    const m = this.moves.get(id);
    if (m?.sim && this.host.traffic.vehicles.has(m.sim.id)) this.host.traffic.release(m.sim);
    this.moves.delete(id);
    this.parked.delete(id);
    for (const [simId, h] of this.homing) if (h.id === id) this.homing.delete(simId);
  }

  /** Такт — после движения: подъезжающие — к проезду, на манёвре — по отрезкам. */
  step(dt: number): void {
    if (this.homing.size) this.stepHoming();
    for (const m of [...this.moves.values()]) if (!this.stepMove(m, dt)) this.moves.delete(m.id);
  }

  /** Подъезжающий передумал (проехал мимо, дорогу поменяли): едет к узлу станции, свой предел скорости. */
  private cancel(sim: Vehicle, h: Homing): void {
    sim.maxSpeed = h.maxSpeed;
    delete sim.endLink;
    if (sim.holdDist !== undefined) this.host.traffic.release(sim);
    this.homing.delete(sim.id);
  }

  private stepHoming(): void {
    const traffic = this.host.traffic;
    for (const [simId, h] of [...this.homing]) {
      const sim = traffic.vehicles.get(simId);
      if (!sim) {
        this.homing.delete(simId);
        continue;
      }
      // Ещё выезжает со двора прошлого получателя (стоит, его держит манёвр) — к следующему поедет, когда тронется.
      if (this.moves.get(h.id)?.sim === sim) continue;
      const geo = this.geoOf(h.b, sim.length, sim.width);
      const slot = geo?.out ? geo.in : null;
      if (!geo || !slot || sim.endLink !== slot.link.id) {
        this.cancel(sim, h);
        continue;
      }
      const L = sim.length;
      // Сколько ещё до места, откуда сворачивать (середина кузова — в mid).
      const left = traffic.routeLeft(sim) - (slot.lane.length - (slot.mid + L / 2));
      // Рампа занята другим грузовиком — не сворачивает, проезжает мимо (игра: объезд квартала и снова, потом — дальше).
      if (!h.close && this.rampBusy(h.b.id, h.id)) {
        if (left < DOCK.slowAt) this.cancel(sim, h);
        continue;
      }
      if (left < DOCK.slowAt) {
        sim.maxSpeed = Math.min(h.maxSpeed, DOCK.slow);
        h.close = true;
      }
      if (left < DOCK.blinkAt) sim.blinker = dot(geo.d.dir, rightNormal(slot.f)) > 0 ? 1 : -1;
      if (sim.holdDist === undefined) {
        const lane = sim.onMovement ? undefined : traffic.currentLane(sim);
        if (!lane || lane.link !== slot.link.id) continue;
        const room = slot.mid + L / 2 - sim.s;
        const late = room < (sim.v * sim.v) / (2 * DOCK.hold) + 0.3;
        if (lane.id !== slot.lane.id) {
          if (late) this.cancel(sim, h);
          continue;
        }
        if (late) this.cancel(sim, h);
        else traffic.holdAfter(sim, room);
        continue;
      }
      if (!traffic.held(sim)) continue;
      if (sim.lane !== slot.lane.id) {
        this.cancel(sim, h);
        continue;
      }
      // Двор общий с покупателями: машина на манёвре у стоянки — подождать.
      if (this.host.lotBusy(h.b.id)) continue;
      this.homing.delete(simId);
      sim.maxSpeed = h.maxSpeed;
      const c0 = sub(sim.pos, scale(sim.dir, L / 2));
      const k = 0.55 * Math.max(2, Math.abs(dot(sub(geo.curbSide, c0), rightNormal(sim.dir))));
      const turn = bezier(c0, add(c0, scale(sim.dir, k)), sub(geo.curbSide, scale(geo.d.dir, k)), geo.curbSide, false, DOCK.speed.roadIn);
      sim.lcCooldown = 1e9;
      const blink = dot(geo.d.dir, rightNormal(slot.f)) > 0 ? 1 : -1;
      this.moves.set(h.id, { id: h.id, geo, kind: 'in', phase: 'legs', legs: [turn, ...geo.inLegs], i: 0, s: 0, v: 0, wait: 0, sim, road: true, blink });
    }
  }

  /** Шаг манёвра; false — кончился. */
  private stepMove(m: Move, dt: number): boolean {
    const traffic = this.host.traffic;
    if (m.sim && !traffic.vehicles.has(m.sim.id)) return false;
    if (m.phase === 'wait') return this.stepWait(m, dt);
    if (m.phase === 'pause') {
      m.wait += dt;
      this.pose(m);
      if (m.wait < DOCK.pause) return true;
      // Встал на полосу носом по ходу — поехал.
      traffic.release(m.sim!);
      m.sim!.lcCooldown = 0.5;
      return false;
    }
    const leg = m.legs[m.i];
    const next = m.legs[m.i + 1];
    // Тем же ходом дальше — не тормозить в конце отрезка; сменить ход — встать.
    const ahead = leg.len - m.s + (next && next.back === leg.back ? next.len : 0);
    const sp = DOCK.speed;
    m.v = Math.max(0.3, Math.min(leg.vmax, m.v + sp.accel * dt, Math.sqrt(2 * sp.brake * Math.max(0, ahead))));
    m.s += m.v * dt;
    while (m.s >= m.legs[m.i].len) {
      const over = m.s - m.legs[m.i].len;
      const was = m.legs[m.i];
      if (m.kind === 'in' && m.road && m.i === 0) {
        // Кузов ушёл с полосы в проезд — в потоке грузовика больше нет.
        const sim = m.sim!;
        traffic.remove(sim);
        m.sim = undefined;
        m.road = false;
        this.host.gone(m.id, sim);
      }
      m.i++;
      if (m.i >= m.legs.length) return this.legsDone(m);
      const now = m.legs[m.i];
      m.s = now.back === was.back ? Math.min(over, now.len) : 0;
      if (now.back !== was.back) m.v = 0;
    }
    this.pose(m);
    return true;
  }

  /** Все отрезки пройдены: въехал — у рампы; выехал со двора — к бордюру ждать; встал на полосу — пауза. */
  private legsDone(m: Move): boolean {
    m.i = m.legs.length - 1;
    m.s = m.legs[m.i].len;
    m.v = 0;
    if (m.kind === 'in') {
      this.parked.set(m.id, m.geo);
      this.host.arrived(m.id);
      return false;
    }
    m.wait = 0;
    m.phase = m.phase === 'join' ? 'pause' : 'wait';
    this.pose(m);
    return true;
  }

  /** У бордюра: настоящий просвет и двор свободен — в поток (стоит, пока выезжает на полосу). */
  private stepWait(m: Move, dt: number): boolean {
    m.wait += dt;
    const geo = this.geoOf(m.geo.b, m.geo.L, m.geo.W) ?? m.geo;
    const out = geo.out;
    const traffic = this.host.traffic;
    if (!out || m.wait < DOCK.look || this.host.lotBusy(geo.b.id) || !traffic.clearToJoin(out.lane.id, out.zone[0], out.zone[1])) return true;
    const L = geo.L;
    const sim = traffic.placeOnLane({ ...m.spec!, targetNode: m.target!, endLink: m.endLink }, out.lane.id, out.mid + L / 2);
    if (!sim) return true;
    traffic.holdAfter(sim, 0);
    if (m.endLink !== undefined) sim.endLink = m.endLink;
    sim.lcCooldown = 1e9;
    const start = geo.curbSide;
    const k = 0.55 * Math.max(2, Math.abs(dot(sub(start, out.pos), rightNormal(out.f))));
    const back = geo.yard.kind === 'back';
    // 'turn' — передом направо, 'back' — задом, как из гаража (нос по ходу полосы в конце).
    const leg = back
      ? bezier(start, sub(start, scale(geo.d.dir, k)), add(out.pos, scale(out.f, k)), out.pos, true, DOCK.speed.roadOut)
      : bezier(start, sub(start, scale(geo.d.dir, k)), sub(out.pos, scale(out.f, k)), out.pos, false, DOCK.speed.roadOut);
    m.geo = geo;
    m.sim = sim;
    m.phase = 'join';
    m.legs = [leg];
    m.i = 0;
    m.s = 0;
    m.v = 0;
    m.blink = back ? 0 : dot(out.f, rightNormal(scale(geo.d.dir, -1))) > 0 ? 1 : -1;
    this.pose(m);
    this.host.joined(m.id, sim);
    return true;
  }

  /** Машина в потоке на манёвре — там, где она на нём (поток держит её на месте: holdAfter). */
  private pose(m: Move): void {
    const sim = m.sim;
    if (!sim) return;
    const { c, h } = legPose(m.legs[m.i], m.s);
    const nose = add(c, scale(h, sim.length / 2));
    sim.pos = nose;
    sim.dir = h;
    sim.rear = sub(nose, scale(h, steerBase(sim.body) * sim.length));
    sim.v = 0;
    sim.blinker = m.blink;
  }

  /**
   * Где грузовик id во дворе (не в потоке): нос и курс — на манёвре или у рампы; в потоке (кузов над полосой) или не
   * во дворе — null.
   */
  poseOf(id: number): { pos: Vec; dir: Vec } | null {
    const m = this.moves.get(id);
    if (m) {
      if (m.sim) return null;
      const { c, h } = legPose(m.legs[m.i], m.s);
      return { pos: add(c, scale(h, m.geo.L / 2)), dir: h };
    }
    const geo = this.parked.get(id);
    if (!geo) return null;
    return { pos: add(geo.ramp.c, scale(geo.ramp.h, geo.L / 2)), dir: geo.ramp.h };
  }

  /** Грузовики во дворах (не в потоке): id. */
  yardIds(): number[] {
    const out: number[] = [];
    for (const m of this.moves.values()) if (!m.sim) out.push(m.id);
    for (const id of this.parked.keys()) out.push(id);
    return out;
  }
}

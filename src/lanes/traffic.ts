import { IDM, LIGHTS } from '../config';
import { lerp as lerpNum } from '../core/math';
import { rightNormal, scale, add, type Vec } from '../core/vec';
import type { Vehicle, VehicleSpec } from '../sim/vehicle';
import { GLane, GMove, GNode, LaneGraph } from './graph';
import { findLaneRoute } from './routing';

export interface LaneTrafficEvents {
  /** Можно ли машине завершить поездку сейчас. */
  canArrive?(v: Vehicle): boolean;
  onArrive(v: Vehicle): void;
  onLost(v: Vehicle): void;
}

export interface LaneSpawn extends VehicleSpec {
  targetNode: number;
  /** Связи от первой до той, что приходит в targetNode. */
  route: number[];
}

/** Сколько машина смотрит вперёд через продолжения полос в поисках лидера. */
const LOOKAHEAD = 250;
/** После стольких секунд ожидания на второстепенной машину пропускают, даже если главная не пустеет. */
const COURTESY = 40;
/** Бронь узла машиной, которой ехать до него дольше, — «мягкая»: её можно перехватить. */
const SOFT_GRANT = 3.5;

function idmAccel(v: number, v0: number, gap: number, dv: number, aMax: number): number {
  const sStar = IDM.minGap + Math.max(0, v * IDM.headway + (v * dv) / (2 * Math.sqrt(aMax * IDM.brake)));
  const free = 1 - Math.pow(v / Math.max(0.1, v0), 4);
  const g = Math.max(0.1, gap);
  return aMax * (free - (sStar / g) * (sStar / g));
}

/** Детерминированный разброс 0…1 — чтобы машины не перестраивали маршрут одновременно. */
function jitter(x: number): number {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/** Шлагбаум посреди полотна (переезд): закрыт — машины ждут перед ним; занят — на нём машина. */
export interface Barrier {
  /** Где на оси полотна. */
  s: number;
  closed: boolean;
  busy: boolean;
}

/** Стоп-линия — на столько раньше шлагбаума (полпути и запас). */
const BARRIER_STOP = 12;

function insertSorted(list: Vehicle[], veh: Vehicle): void {
  let i = list.length;
  while (i > 0 && list[i - 1].s < veh.s) i--;
  list.splice(i, 0, veh);
}

/**
 * Движение по сети полос. Модель следования (IDM), перестроения внутри связи и проезд перекрёстков
 * по очереди с конфликтами и главной дорогой — как в прежней модели; продолжение полосы через стык
 * или границу связи проходится без остановки, лидер ищется и за ним.
 */
export class LaneTraffic {
  readonly vehicles = new Map<number, Vehicle>();
  private nextId = 1;
  time = 0;
  arrivals = 0;
  totalTripTime = 0;
  /** Шлагбаумы по полотнам. */
  barriers = new Map<number, Barrier[]>();

  constructor(
    public graph: LaneGraph,
    private readonly events: LaneTrafficEvents,
  ) {}

  /**
   * Сеть перестроили: машины встают на полосу нового графа там же, где ехали (ближайшая попутная
   * полоса у их положения), и прокладывают маршрут заново. Кому некуда — теряются.
   */
  rebind(graph: LaneGraph): void {
    // Светофоры не сбрасываются: та же фаза и тот же отсчёт, если фаз столько же.
    for (const [id, g] of graph.nodes) {
      const was = this.graph.nodes.get(id)?.lights;
      if (g.lights && was && was.phases.length === g.lights.phases.length) {
        g.lights.phase = was.phase;
        g.lights.timer = was.timer;
        g.lights.clearing = was.clearing;
      }
    }
    this.graph = graph;
    for (const veh of [...this.vehicles.values()]) {
      veh.onMovement = null;
      veh.granted = null;
      veh.planned = null;
      veh.waitingAt = null;
      veh.ready = false;
      const spot = this.laneAt(veh.pos, veh.dir);
      const route = spot && findLaneRoute(graph, [graph.links.get(spot.lane.link)!], veh.targetNode);
      if (!spot || !route) {
        this.vehicles.delete(veh.id);
        this.events.onLost(veh);
        continue;
      }
      veh.lane = spot.lane.id;
      veh.s = spot.u;
      veh.route = route;
      veh.routeIndex = 0;
      veh.lateral = 0;
      insertSorted(spot.lane.vehicles, veh);
      this.updatePose(veh);
    }
  }

  /** Попутная полоса у точки: ближайшая по смещению среди связей, идущих примерно по dir. */
  private laneAt(p: Vec, dir: Vec): { lane: GLane; u: number } | null {
    let best: { lane: GLane; u: number } | null = null;
    let bestD = 6;
    for (const c of this.graph.net.corridorsNear(p, 40)) {
      const hit = c.lut.closest(p);
      if (hit.d > 40) continue;
      const t = c.lut.tangentAt(hit.s);
      const lat = (p.x - hit.point.x) * -t.y + (p.y - hit.point.y) * t.x;
      for (const link of this.graph.corridorLinks(c.id)) {
        if (hit.s < link.s0 - 0.5 || hit.s > link.s1 + 0.5 || (t.x * dir.x + t.y * dir.y) * link.flow < 0.3) continue;
        for (const lane of link.lanes) {
          const d = Math.abs(lane.offset - lat);
          if (d < bestD) {
            bestD = d;
            const u = link.flow > 0 ? hit.s - link.s0 : link.s1 - hit.s;
            best = { lane, u: Math.max(0, Math.min(lane.length, u)) };
          }
        }
      }
    }
    return best;
  }

  currentLane(v: Vehicle): GLane | undefined {
    return this.graph.lanes.get(v.lane);
  }

  private hasTransition(lane: GLane, nextLink: number): boolean {
    for (const m of this.graph.movesFrom.get(lane.id) ?? []) if (m.outLink === nextLink) return true;
    return false;
  }

  private spaceAtStart(lane: GLane, need: number): boolean {
    const last = lane.vehicles[lane.vehicles.length - 1];
    if (last && last.s - last.length < need) return false;
    for (const m of this.graph.movesInto.get(lane.id) ?? []) {
      for (const veh of m.vehicles) if (m.length - veh.s < need) return false;
    }
    return true;
  }

  spawn(opts: LaneSpawn): Vehicle | null {
    const link = this.graph.links.get(opts.route[0]);
    if (!link) return null;
    const next = opts.route[1];
    const rightFirst = [...link.lanes].reverse();
    const good = next === undefined ? rightFirst : rightFirst.filter((l) => this.hasTransition(l, next));
    const lane = (good.length ? good : rightFirst).find((l) => this.spaceAtStart(l, opts.length + IDM.minGap + 1));
    if (!lane) return null;
    const { targetNode, route, ...spec } = opts;
    const pose = this.graph.lanePose(lane, 0);
    const veh: Vehicle = {
      ...spec,
      id: this.nextId++,
      targetNode,
      route,
      routeIndex: 0,
      lane: lane.id,
      onMovement: null,
      granted: null,
      planned: null,
      waitingAt: null,
      requestTime: 0,
      ready: false,
      s: 0,
      v: 3,
      pos: pose.pos,
      dir: pose.dir,
      level: 0,
      centerS: 0,
      lateral: 0,
      tripTime: 0,
      stoppedTime: 0,
      stuckTimer: 0,
      rerouteTimer: 3 + jitter(this.nextId) * 3,
      lcCooldown: 0.5,
    };
    lane.vehicles.push(veh);
    this.vehicles.set(veh.id, veh);
    this.updatePose(veh);
    return veh;
  }

  remove(veh: Vehicle): void {
    if (!this.vehicles.has(veh.id)) return;
    this.vehicles.delete(veh.id);
    const lane = this.currentLane(veh);
    if (lane) lane.vehicles = lane.vehicles.filter((x) => x !== veh);
    if (veh.onMovement) {
      const m = this.graph.moves.get(veh.onMovement);
      if (m) m.vehicles = m.vehicles.filter((x) => x !== veh);
    }
    this.releaseNode(veh);
  }

  private releaseNode(veh: Vehicle): void {
    for (const n of this.graph.nodes.values()) {
      if (n.reserved.includes(veh)) n.reserved = n.reserved.filter((x) => x !== veh);
      if (n.waiting.includes(veh)) n.waiting = n.waiting.filter((x) => x !== veh);
    }
    veh.waitingAt = null;
  }

  private revokeGrant(veh: Vehicle): void {
    if (!veh.granted) return;
    const m = this.graph.moves.get(veh.granted);
    const node = m?.node !== null && m ? this.graph.nodes.get(m.node) : undefined;
    if (node) node.reserved = node.reserved.filter((x) => x !== veh);
    veh.granted = null;
  }

  step(dt: number): void {
    this.time += dt;
    this.updateLights(dt);
    const list = [...this.vehicles.values()];
    for (const veh of list) if (!veh.onMovement) this.laneChange(veh, dt);
    const accel = new Map<Vehicle, number>();
    for (const veh of list) accel.set(veh, this.computeAccel(veh, dt));
    for (const veh of list) if (this.vehicles.has(veh.id)) this.integrate(veh, accel.get(veh)!, dt);
    for (const veh of list) {
      if (!this.vehicles.has(veh.id)) continue;
      veh.rerouteTimer -= dt;
      if (veh.rerouteTimer <= 0) {
        veh.rerouteTimer = 4 + jitter(veh.id + this.time) * 2;
        this.dynamicReroute(veh);
      }
    }
    this.markBarriers();
  }

  /** Какие шлагбаумы заняты: машина между стоп-линией и дальним краем переезда. */
  private markBarriers(): void {
    if (!this.barriers.size) return;
    for (const list of this.barriers.values()) for (const b of list) b.busy = false;
    for (const veh of this.vehicles.values()) {
      if (veh.onMovement) continue;
      const lane = this.currentLane(veh);
      const link = lane && this.graph.links.get(lane.link);
      const list = link && this.barriers.get(link.corridor);
      if (!list) continue;
      for (const b of list) {
        const d = link.flow * (veh.centerS - b.s);
        if (d > -BARRIER_STOP && d < BARRIER_STOP + veh.length) b.busy = true;
      }
    }
  }

  /** До ближайшего закрытого шлагбаума впереди на связи: от оси from (нет — от начала связи); нет — Infinity. */
  private barrierAhead(linkId: number, from: number | null): number {
    const link = this.graph.links.get(linkId);
    const list = link && this.barriers.get(link.corridor);
    if (!list) return Infinity;
    const start = from ?? (link.flow > 0 ? link.s0 : link.s1);
    let best = Infinity;
    for (const b of list) {
      if (!b.closed) continue;
      const stop = b.s - link.flow * BARRIER_STOP;
      if (stop < link.s0 - 0.01 || stop > link.s1 + 0.01) continue;
      // Проехавшая стоп-линию машина освобождает переезд, а не встаёт на рельсах.
      const d = link.flow * (stop - start);
      if (d > -0.5) best = Math.min(best, Math.max(0, d));
    }
    return best;
  }

  // ---------- Перестроения ----------

  private laneChange(veh: Vehicle, dt: number): void {
    veh.lcCooldown -= dt;
    if (veh.lcCooldown > 0 || veh.granted) return;
    const lane = this.currentLane(veh);
    if (!lane) return;
    const link = this.graph.links.get(lane.link)!;
    if (link.lanes.length < 2) return;
    const next = veh.routeIndex < veh.route.length - 1 ? veh.route[veh.routeIndex + 1] : undefined;
    const ok = (l: GLane) => next === undefined || this.hasTransition(l, next);
    const remaining = lane.length - veh.s;
    let target: GLane | undefined;
    let mandatory = false;
    if (!ok(lane)) {
      // Полоса кончается или ведёт не туда — перестраиваемся к ближайшей подходящей.
      const good = link.lanes.filter(ok).map((l) => l.index);
      if (!good.length) return;
      const nearest = good.reduce((a, b) => (Math.abs(b - lane.index) < Math.abs(a - lane.index) ? b : a));
      target = link.lanes[lane.index + Math.sign(nearest - lane.index)];
      mandatory = true;
    } else if (remaining > 50) {
      const idx = lane.vehicles.indexOf(veh);
      const leader = idx > 0 ? lane.vehicles[idx - 1] : undefined;
      const gapAhead = leader ? leader.s - leader.length - veh.s : Infinity;
      if (leader && gapAhead < 30 && leader.v < Math.min(lane.speed, veh.maxSpeed) * 0.7) {
        for (const d of [-1, 1]) {
          const adj = link.lanes[lane.index + d];
          if (!adj || !ok(adj)) continue;
          if (this.freeAhead(adj, veh.s) > gapAhead + 20) {
            target = adj;
            break;
          }
        }
      }
    }
    if (!target) return;
    // Через сплошную не перестраиваются.
    const leftOne = target.index < lane.index ? target : lane;
    if (leftOne.solidRight) return;
    const urgency = mandatory ? Math.max(0, Math.min(1, 1 - remaining / 140)) : 0;
    if (this.safeToEnter(target, veh, urgency)) {
      this.moveToLane(veh, lane, target);
      veh.lcCooldown = mandatory ? 0.5 : 3;
    } else {
      veh.lcCooldown = 0.2;
    }
  }

  private freeAhead(lane: GLane, s: number): number {
    let best = Infinity;
    for (const o of lane.vehicles) if (o.s >= s) best = o.s - o.length - s;
    return Math.min(best, lane.length - s + 30);
  }

  private safeToEnter(target: GLane, veh: Vehicle, urgency: number): boolean {
    let leader: Vehicle | undefined;
    let follower: Vehicle | undefined;
    for (const o of target.vehicles) {
      if (o.s >= veh.s) leader = o;
      else {
        follower = o;
        break;
      }
    }
    const aheadNeed = lerpNum(2 + veh.v * 0.5, 0.8, urgency);
    if (leader && leader.s - leader.length - veh.s < aheadNeed) return false;
    if (follower) {
      const behindNeed = lerpNum(3 + follower.v * 0.8, 1, urgency);
      if (veh.s - veh.length - follower.s < behindNeed) return false;
    }
    // Хвост ещё в начале полосы: не мешаем тем, кто въезжает в неё с манёвра.
    if (veh.s - veh.length < 6) {
      for (const m of this.graph.movesInto.get(target.id) ?? []) {
        for (const o of m.vehicles) if (m.length - o.s < 8) return false;
      }
    }
    return true;
  }

  private moveToLane(veh: Vehicle, from: GLane, to: GLane): void {
    from.vehicles = from.vehicles.filter((x) => x !== veh);
    insertSorted(to.vehicles, veh);
    veh.lateral += from.side - to.side;
    veh.lane = to.id;
    veh.planned = null;
    if (veh.waitingAt !== null) this.releaseNode(veh);
    const behind = to.vehicles[to.vehicles.indexOf(veh) + 1];
    if (behind?.granted) this.revokeGrant(behind);
  }

  // ---------- Движение ----------

  /** Переход с полосы на следующую связь маршрута: продолжение полосы или манёвр с наименьшей очередью. */
  private pickMovement(veh: Vehicle, lane: GLane, routeIndex = veh.routeIndex): GMove | undefined {
    const own = routeIndex === veh.routeIndex && lane.id === veh.lane;
    if (own && veh.granted) return this.graph.moves.get(veh.granted);
    const next = veh.route[routeIndex + 1];
    if (next === undefined) return undefined;
    const after = veh.route[routeIndex + 2];
    let best: GMove | undefined;
    let bestScore = Infinity;
    for (const m of this.graph.movesFrom.get(lane.id) ?? []) {
      if (m.outLink !== next) continue;
      if (m.cont) return m;
      const out = this.graph.lanes.get(m.outLane);
      if (!out) continue;
      let score = out.vehicles.length * 3 + m.vehicles.length * 2;
      if (after !== undefined && !this.hasTransition(out, after)) score += 40;
      if (own && m.key === veh.planned) score -= 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (own) veh.planned = best?.key ?? null;
    return best;
  }

  private computeAccel(veh: Vehicle, dt: number): number {
    const aMax = veh.accel;
    if (veh.onMovement) {
      const m = this.graph.moves.get(veh.onMovement)!;
      const idx = m.vehicles.indexOf(veh);
      let gap = Infinity;
      let leaderV = 0;
      if (idx > 0) {
        const leader = m.vehicles[idx - 1];
        gap = leader.s - leader.length - veh.s;
        leaderV = leader.v;
      } else {
        const out = this.graph.lanes.get(m.outLane);
        const last = out?.vehicles[out.vehicles.length - 1];
        if (last) {
          gap = m.length - veh.s + last.s - last.length;
          leaderV = last.v;
        }
      }
      return idmAccel(veh.v, Math.min(m.speed, veh.maxSpeed), gap, veh.v - leaderV, aMax);
    }

    const lane = this.currentLane(veh)!;
    const idx = lane.vehicles.indexOf(veh);
    let desired = Math.min(lane.speed, veh.maxSpeed);
    // Закрытый переезд впереди на этой связи — как стоп-линия.
    const barrier = this.barrierAhead(lane.link, veh.centerS);
    const atBarrier = barrier < Infinity ? idmAccel(veh.v, desired, barrier + IDM.minGap - 0.5, veh.v, aMax) : Infinity;
    if (idx > 0) {
      // Впереди оказалась другая машина (въехала в полосу) — разрешение и место в очереди отдаём.
      if (veh.granted) this.revokeGrant(veh);
      if (veh.waitingAt !== null) this.releaseNode(veh);
      const leader = lane.vehicles[idx - 1];
      return Math.min(atBarrier, idmAccel(veh.v, desired, leader.s - leader.length - veh.s, veh.v - leader.v, aMax));
    }
    if (atBarrier < Infinity) return atBarrier;

    // Первая в полосе: смотрим вперёд по маршруту через продолжения полос — до лидера,
    // до перекрёстка, закрытого переезда или до конца пути.
    let ahead = lane.length - veh.s;
    let cur = lane;
    let ri = veh.routeIndex;
    for (let hop = 0; ; hop++) {
      if (ri === veh.route.length - 1) return idmAccel(veh.v, desired, ahead + IDM.minGap + 1.5, veh.v, aMax);
      const m = this.pickMovement(veh, cur, ri);
      if (!m) {
        // Полоса кончается, а перестроиться не вышло: стоим у её конца.
        if (cur === lane && ahead < 2 && veh.v < 0.5) {
          veh.stuckTimer += dt;
          if (veh.stuckTimer > 4) this.escapeWrongLane(veh, lane);
        }
        return idmAccel(veh.v, desired, ahead + IDM.minGap - 0.5, veh.v, aMax);
      }
      if (m.cont) {
        const out = this.graph.lanes.get(m.outLane)!;
        const last = out.vehicles[out.vehicles.length - 1];
        const bar = this.barrierAhead(out.link, null);
        if (bar < (last ? last.s - last.length : Infinity)) return idmAccel(veh.v, desired, ahead + bar + IDM.minGap - 0.5, veh.v, aMax);
        if (last) return idmAccel(veh.v, desired, ahead + last.s - last.length, veh.v - last.v, aMax);
        if (ahead > LOOKAHEAD || hop > 8) return idmAccel(veh.v, desired, Infinity, 0, aMax);
        ahead += out.length;
        cur = out;
        ri++;
        continue;
      }
      veh.stuckTimer = 0;
      desired = Math.min(desired, Math.sqrt(m.speed * m.speed + IDM.brake * ahead));
      // Проезд просим, только стоя в последней полосе перед узлом; дальше узел — как стоп-линия.
      if (cur !== lane) return idmAccel(veh.v, desired, ahead + IDM.minGap - 0.5, veh.v, aMax);
      if (veh.granted !== m.key && ahead <= this.grantLookahead(veh, m)) this.tryGrant(veh, m);
      let gap: number;
      let leaderV = 0;
      if (veh.granted === m.key) {
        gap = Infinity;
        const lastOnM = m.vehicles[m.vehicles.length - 1];
        if (lastOnM) {
          gap = ahead + lastOnM.s - lastOnM.length;
          leaderV = lastOnM.v;
        } else {
          const out = this.graph.lanes.get(m.outLane);
          const last = out?.vehicles[out.vehicles.length - 1];
          if (last) {
            gap = ahead + m.length + last.s - last.length;
            leaderV = last.v;
          }
        }
      } else {
        gap = ahead + IDM.minGap - 0.5;
      }
      return idmAccel(veh.v, desired, gap, veh.v - leaderV, aMax);
    }
  }

  /** За сколько до узла просить проезд: без конфликтов и на главной — заранее, иначе ближе. */
  private grantLookahead(veh: Vehicle, m: GMove): number {
    const stop = (veh.v * veh.v) / (2 * IDM.brake * 0.6) + 6;
    const node = this.graph.nodes.get(m.node!)!;
    const through = !node.lights && (m.conflicts.size === 0 || node.priorityLanes.has(m.inLane));
    if (!through) return Math.max(stop, 8);
    const sStar = IDM.minGap + veh.v * IDM.headway + (veh.v * veh.v) / (2 * Math.sqrt(veh.accel * IDM.brake));
    return Math.max(stop, sStar * 3, 8);
  }

  /** Машина застряла не в той полосе: ищем объезд из текущей полосы. */
  private escapeWrongLane(veh: Vehicle, lane: GLane): void {
    veh.stuckTimer = 0;
    const exits = new Set<number>();
    for (const m of this.graph.movesFrom.get(lane.id) ?? []) exits.add(m.outLink);
    const starts = [...exits].map((id) => this.graph.links.get(id)!).filter(Boolean);
    const rest = findLaneRoute(this.graph, starts, veh.targetNode);
    if (rest) this.setRoute(veh, [lane.link, ...rest]);
    else this.lose(veh);
  }

  private integrate(veh: Vehicle, a: number, dt: number): void {
    veh.tripTime += dt;
    veh.v = Math.max(0, Math.min(veh.maxSpeed * 1.05, veh.v + a * dt));
    if (veh.v < 0.5) veh.stoppedTime += dt;
    veh.s += veh.v * dt;
    if (veh.lateral !== 0) {
      const step = Math.min(Math.abs(veh.lateral), (6 + veh.v * 0.2) * dt);
      veh.lateral -= Math.sign(veh.lateral) * step;
    }
    if (veh.onMovement) {
      const m = this.graph.moves.get(veh.onMovement)!;
      if (veh.s >= m.length) {
        m.vehicles = m.vehicles.filter((x) => x !== veh);
        const node = this.graph.nodes.get(m.node!);
        if (node) node.reserved = node.reserved.filter((x) => x !== veh);
        veh.s -= m.length;
        veh.onMovement = null;
        veh.planned = null;
        veh.routeIndex++;
        veh.lane = m.outLane;
        insertSorted(this.graph.lanes.get(m.outLane)!.vehicles, veh);
      }
    }
    // На коротких полосах за шаг можно проскочить несколько продолжений.
    for (let guard = 0; !veh.onMovement && guard < 8; guard++) {
      const lane = this.currentLane(veh)!;
      const isLast = veh.routeIndex === veh.route.length - 1;
      if (isLast && veh.s >= lane.length - 0.5) {
        if (this.events.canArrive && !this.events.canArrive(veh)) {
          veh.s = lane.length - 0.5;
          veh.v = 0;
          break;
        }
        this.arrivals++;
        this.totalTripTime += veh.tripTime;
        this.remove(veh);
        this.events.onArrive(veh);
        return;
      }
      if (veh.s < lane.length) break;
      const m = veh.granted ? this.graph.moves.get(veh.granted) : this.pickMovement(veh, lane);
      if (m && lane.vehicles[0] === veh && (m.cont || veh.granted === m.key)) {
        lane.vehicles.shift();
        veh.s -= lane.length;
        veh.planned = null;
        if (m.cont) {
          veh.routeIndex++;
          veh.lane = m.outLane;
          insertSorted(this.graph.lanes.get(m.outLane)!.vehicles, veh);
          continue;
        }
        veh.onMovement = m.key;
        veh.granted = null;
        m.vehicles.push(veh);
      } else {
        veh.s = lane.length;
        veh.v = 0;
      }
      break;
    }
    this.updatePose(veh);
  }

  /** Курс кузова: задняя ось тянется за передней на длину базы — корма срезает угол на повороте. */
  private steer(veh: Vehicle, pathDir: Vec): void {
    const base = veh.length * 0.7;
    const front = veh.pos;
    let rear = veh.rear;
    const d = rear ? Math.hypot(front.x - rear.x, front.y - rear.y) : 0;
    if (!rear || d < base * 0.5 || d > base * 1.6) rear = { x: front.x - pathDir.x * base, y: front.y - pathDir.y * base };
    const dx = front.x - rear.x;
    const dy = front.y - rear.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) {
      veh.dir = pathDir;
      return;
    }
    veh.dir = { x: dx / l, y: dy / l };
    veh.rear = { x: front.x - veh.dir.x * base, y: front.y - veh.dir.y * base };
  }

  updatePose(veh: Vehicle): void {
    if (veh.onMovement) {
      const m = this.graph.moves.get(veh.onMovement);
      if (!m) return;
      const p = LaneGraph.pointOnMove(m, veh.s);
      veh.pos = p.pos;
      this.steer(veh, p.dir);
      if (m.node !== null) veh.level = this.graph.net.nodes.get(m.node)?.level ?? veh.level;
      return;
    }
    const lane = this.currentLane(veh);
    if (!lane) return;
    const pose = this.graph.lanePose(lane, Math.min(veh.s, lane.length));
    veh.pos = add(pose.pos, scale(rightNormal(pose.dir), veh.lateral));
    this.steer(veh, pose.dir);
    veh.centerS = this.graph.axisS(lane, veh.s);
    const c = this.graph.net.corridors.get(this.graph.links.get(lane.link)!.corridor);
    if (c) veh.level = this.graph.net.heightAt(c, veh.centerS);
  }

  // ---------- Проезд узлов ----------

  /** Зелёный ли этой полосе въезда (без светофора — всегда). */
  private lightAllows(node: GNode, m: GMove): boolean {
    const L = node.lights;
    if (!L) return true;
    return !L.clearing && L.phases[L.phase].includes(m.inLane);
  }

  /** Сколько машин подъезжает к узлу по полосам фазы. */
  private phaseDemand(phase: number[]): number {
    let demand = 0;
    for (const id of phase) {
      const lane = this.graph.lanes.get(id);
      if (!lane) continue;
      for (const veh of lane.vehicles) if (lane.length - veh.s < 70) demand++;
    }
    return demand;
  }

  /** Светофоры: зелёный по фазам по кругу, между ними — жёлтый; «умный» пропускает пустые фазы и держит зелёный, пока никто не ждёт. */
  private updateLights(dt: number): void {
    for (const node of this.graph.nodes.values()) {
      const L = node.lights;
      if (!L) continue;
      L.timer -= dt;
      if (L.timer > 0) continue;
      const settings = this.graph.net.nodes.get(node.id);
      const adaptive = settings?.adaptive !== false;
      if (L.clearing) {
        L.clearing = false;
        for (let i = 1; i <= L.phases.length; i++) {
          const p = (L.phase + i) % L.phases.length;
          if (!adaptive || this.phaseDemand(L.phases[p]) > 0 || i === L.phases.length) {
            L.phase = p;
            break;
          }
        }
        L.timer = settings?.greens?.[L.phase] ?? LIGHTS.green;
      } else if (adaptive && !L.phases.some((p, i) => i !== L.phase && this.phaseDemand(p) > 0)) {
        L.timer = 2;
      } else {
        L.clearing = true;
        L.timer = LIGHTS.clearance;
      }
    }
  }

  private tryGrant(veh: Vehicle, m: GMove): boolean {
    const node = this.graph.nodes.get(m.node!)!;
    if (veh.waitingAt !== node.id) {
      if (veh.waitingAt !== null) this.releaseNode(veh);
      veh.waitingAt = node.id;
      veh.requestTime = this.time;
      node.waiting.push(veh);
    }
    veh.ready = this.lightAllows(node, m) && this.hasSpace(node, m, veh);
    if (!veh.ready) return false;
    // Подстраховка от зависших броней: держать узел может только машина на манёвре
    // или первая в своей полосе с действующим разрешением.
    node.reserved = node.reserved.filter((r) => {
      if (!this.vehicles.has(r.id)) return false;
      if (r.onMovement) return true;
      if (!r.granted) return false;
      const lane = this.currentLane(r);
      if (lane && lane.vehicles[0] === r) return true;
      r.granted = null;
      return false;
    });
    // В очереди — только те, кто стоит первым в своей полосе перед этим узлом.
    node.waiting = node.waiting.filter((w) => {
      const lane = this.currentLane(w);
      const link = lane && this.graph.links.get(lane.link);
      const ok = this.vehicles.has(w.id) && !w.onMovement && w.waitingAt === node.id && !!lane && lane.vehicles[0] === w && link?.toNode === node.id;
      if (!ok && w.waitingAt === node.id) w.waitingAt = null;
      return ok;
    });
    // Бронь того, кто ещё далеко, — не помеха: если сами успеем проехать, его бронь снимем,
    // и он попросит проезд заново (на главной — заранее, чтобы не тормозить, поэтому брони там дальние).
    const soft: Vehicle[] = [];
    for (const r of node.reserved) {
      const rKey = r.onMovement ?? r.granted;
      if (!rKey || rKey === m.key) continue;
      const kind = m.conflicts.get(rKey);
      if (!kind) continue;
      if (kind === 'diverge' && r.onMovement && r.s > r.length + 3) continue;
      // Пересечение: тот уже целиком проехал общую зону — путь свободен.
      if (kind === 'cross' && r.onMovement) {
        const zone = this.graph.moves.get(r.onMovement)?.zones.get(m.key);
        if (zone && r.s - r.length > zone[1] + 1) continue;
      }
      // Вливание в ту же полосу: тот выедет на неё заметно раньше нас — поедем следом за ним.
      if (kind === 'merge' && r.onMovement) {
        const rm = this.graph.moves.get(r.onMovement);
        if (rm && rm.length - r.s + r.length + IDM.minGap < m.length - 4) continue;
      }
      if (!r.onMovement && this.etaToNode(r) > SOFT_GRANT && this.etaToNode(veh) < 1.5) {
        soft.push(r);
        continue;
      }
      return false;
    }
    const isPriority = node.priorityLanes.has(m.inLane);
    // Совсем заждавшегося на второстепенной пропускают: главная ждёт его по брони узла, как обычного.
    const waited = this.time - veh.requestTime;
    if (node.priorityLanes.size && !isPriority && waited < COURTESY && this.mustYield(node, m, waited)) return false;
    for (const w of node.waiting) {
      if (w === veh || !w.ready || w.requestTime >= veh.requestTime - 0.05) continue;
      if (isPriority && !node.priorityLanes.has(w.lane)) continue;
      const wKey = w.planned;
      if (wKey && wKey !== m.key && m.conflicts.has(wKey)) return false;
    }
    for (const r of soft) this.revokeGrant(r);
    veh.granted = m.key;
    node.waiting = node.waiting.filter((x) => x !== veh);
    veh.waitingAt = null;
    node.reserved.push(veh);
    return true;
  }

  /** Сколько секунд машине до конца её полосы (до узла) при нынешней скорости. */
  private etaToNode(v: Vehicle): number {
    const lane = this.currentLane(v);
    if (!lane) return 0;
    return (lane.length - v.s) / Math.max(v.v, 1);
  }

  /**
   * Уступить главной: кто-то на ней въедет в узел наперерез раньше, чем через window секунд.
   * Ползущие в своей очереди — не помеха: если доползут, их задержит бронь узла. Долго ждущий
   * соглашается на меньший разрыв.
   */
  private mustYield(node: GNode, m: GMove, waited: number): boolean {
    const window = waited > 15 ? 1.8 : 2.8;
    const checked = new Set<number>();
    for (const pl of node.priorityLanes) {
      for (const { veh, distance } of this.upstream(pl, 120)) {
        if (checked.has(veh.id)) continue;
        checked.add(veh.id);
        if (veh.v < 1 && !veh.onMovement) continue;
        if (distance > 8 && distance / veh.v > window) continue;
        for (const key of this.potentialMovements(veh, node.id)) {
          const kind = m.conflicts.get(key);
          if (kind && kind !== 'diverge') return true;
        }
      }
    }
    return false;
  }

  /** Машины выше по потоку от конца полосы в пределах maxDist. */
  private upstream(laneId: number, maxDist: number): { veh: Vehicle; distance: number }[] {
    const result: { veh: Vehicle; distance: number }[] = [];
    const visit = (id: number, offset: number, depth: number) => {
      const lane = this.graph.lanes.get(id);
      if (!lane || offset > maxDist || depth > 6) return;
      for (const veh of lane.vehicles) result.push({ veh, distance: offset + lane.length - veh.s });
      const base = offset + lane.length;
      for (const mv of this.graph.movesInto.get(id) ?? []) {
        for (const veh of mv.vehicles) result.push({ veh, distance: base + mv.length - veh.s });
        visit(mv.inLane, base + mv.length, depth + 1);
      }
    };
    visit(laneId, 0, 0);
    return result;
  }

  /** Манёвры, которые машина может совершить в узле по своему маршруту. */
  private potentialMovements(veh: Vehicle, nodeId: number): string[] {
    for (let i = veh.routeIndex; i < veh.route.length - 1; i++) {
      const link = this.graph.links.get(veh.route[i]);
      if (link?.toNode !== nodeId) continue;
      if (i === veh.routeIndex && !veh.onMovement) {
        const key = veh.granted ?? veh.planned;
        if (key) return [key];
      }
      return (this.graph.transitions.get(`${veh.route[i]}>${veh.route[i + 1]}`) ?? []).map((mv) => mv.key);
    }
    return [];
  }

  private hasSpace(node: GNode, m: GMove, veh: Vehicle): boolean {
    const out = this.graph.lanes.get(m.outLane);
    if (!out) return false;
    let committed = 0;
    for (const r of node.reserved) {
      const rKey = r.onMovement ?? r.granted;
      const rm = rKey ? this.graph.moves.get(rKey) : undefined;
      if (rm && rm.outLane === out.id) committed += r.length + IDM.minGap;
    }
    const last = out.vehicles[out.vehicles.length - 1];
    const free = last ? last.s - last.length : out.length + veh.length + IDM.minGap;
    return free - committed >= (veh.length + IDM.minGap) * 0.6;
  }

  // ---------- Маршруты ----------

  private dynamicReroute(veh: Vehicle): void {
    if (veh.onMovement || veh.granted || veh.routeIndex >= veh.route.length - 1) return;
    const lane = this.currentLane(veh);
    const link = lane && this.graph.links.get(lane.link);
    if (!link) return;
    const route = findLaneRoute(this.graph, [link], veh.targetNode);
    if (route) this.setRoute(veh, route);
  }

  private setRoute(veh: Vehicle, routeFromCurrent: number[]): void {
    const oldNext = veh.route[veh.routeIndex + 1];
    veh.route = routeFromCurrent;
    veh.routeIndex = 0;
    if (oldNext !== veh.route[1] && !veh.onMovement) {
      this.revokeGrant(veh);
      veh.planned = null;
      if (veh.waitingAt !== null) this.releaseNode(veh);
    }
  }

  private lose(veh: Vehicle): void {
    this.remove(veh);
    this.events.onLost(veh);
  }
}

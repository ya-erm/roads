import { IDM, LIGHTS } from '../config';
import { lerp as lerpNum } from '../core/math';
import type { Vec } from '../core/vec';
import { Lane, linkId, Movement, Network, RoadNode, SplitRecord } from '../world/network';
import { MAX_LANES } from '../world/roadTypes';
import { findRoute } from './routing';
import type { Vehicle, VehicleSpec } from './vehicle';

export interface TrafficEvents {
  /** Можно ли машине завершить поездку сейчас (например, есть свободный пост погрузки). */
  canArrive?(v: Vehicle): boolean;
  onArrive(v: Vehicle): void;
  onLost(v: Vehicle): void;
}

export interface TrafficSave {
  nextId: number;
  vehicles: Vehicle[];
}

export interface SpawnOptions extends VehicleSpec {
  targetNode: number;
  route: number[];
}

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

function insertSorted(list: Vehicle[], veh: Vehicle): void {
  let i = list.length;
  while (i > 0 && list[i - 1].s < veh.s) i--;
  list.splice(i, 0, veh);
}

const decodeLane = (id: number) => {
  const seg = Math.floor(id / (MAX_LANES * 2));
  const rest = id - seg * MAX_LANES * 2;
  return { seg, dir: (rest >= MAX_LANES ? 1 : 0) as 0 | 1, index: rest % MAX_LANES };
};

export class Traffic {
  readonly vehicles = new Map<number, Vehicle>();
  private nextId = 1;
  time = 0;
  arrivals = 0;
  totalTripTime = 0;

  constructor(
    private readonly net: Network,
    private readonly events: TrafficEvents,
  ) {}

  /** Снимает все машины (перед заменой сети); вернуть их — restore. */
  clearVehicles(): void {
    this.vehicles.clear();
  }

  /** Состояние всех машин для сохранения игры. */
  serialize(): TrafficSave {
    return {
      nextId: this.nextId,
      vehicles: [...this.vehicles.values()].map((v) => ({ ...v, waitingAt: null, ready: false })),
    };
  }

  /**
   * Возвращает машины на их полосы и манёвры после загрузки сети.
   * Разрешения на проезд узлов восстанавливаются, очереди ожидания собираются заново.
   */
  restore(data: TrafficSave): Set<number> {
    this.nextId = data.nextId;
    const restored = new Set<number>();
    const touched = new Set<Vehicle[]>();
    for (const saved of data.vehicles) {
      const veh: Vehicle = { ...saved, waitingAt: null, ready: false };
      if (veh.onMovement) {
        const m = this.net.movements.get(veh.onMovement);
        if (!m) continue;
        m.vehicles.push(veh);
        touched.add(m.vehicles);
        this.net.node(m.node).reserved.push(veh);
      } else {
        const lane = this.net.lanes.get(veh.lane);
        if (!lane) continue;
        lane.vehicles.push(veh);
        touched.add(lane.vehicles);
      }
      if (veh.granted) {
        const g = this.net.movements.get(veh.granted);
        if (g) this.net.node(g.node).reserved.push(veh);
        else veh.granted = null;
      }
      this.vehicles.set(veh.id, veh);
      restored.add(veh.id);
    }
    for (const list of touched) list.sort((a, b) => b.s - a.s);
    return restored;
  }

  currentLane(v: Vehicle): Lane | undefined {
    return this.net.lanes.get(v.lane);
  }

  private hasTransition(lane: Lane, nextLink: number): boolean {
    for (const m of this.net.movesFrom.get(lane.id) ?? []) if (m.outLink === nextLink) return true;
    return false;
  }

  private spaceAtStart(lane: Lane, need: number): boolean {
    const last = lane.vehicles[lane.vehicles.length - 1];
    if (last && last.s - last.length < need) return false;
    for (const m of this.net.movesInto.get(lane.id) ?? []) {
      for (const veh of m.vehicles) if (m.length - veh.s < need) return false;
    }
    return true;
  }

  spawn(opts: SpawnOptions): Vehicle | null {
    const link = this.net.links.get(opts.route[0]);
    if (!link) return null;
    const next = opts.route[1];
    const rightFirst = [...link.lanes].reverse();
    const good = next === undefined ? rightFirst : rightFirst.filter((l) => this.hasTransition(l, next));
    const lane = (good.length ? good : rightFirst).find((l) => this.spaceAtStart(l, opts.length + IDM.minGap + 1));
    if (!lane) return null;
    const { targetNode, route, ...spec } = opts;
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
      pos: { ...lane.start },
      dir: { ...lane.startDir },
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
      const m = this.net.movements.get(veh.onMovement);
      if (m) m.vehicles = m.vehicles.filter((x) => x !== veh);
    }
    this.releaseNode(veh);
  }

  private releaseNode(veh: Vehicle): void {
    for (const n of this.net.nodes.values()) {
      if (n.reserved.includes(veh)) n.reserved = n.reserved.filter((x) => x !== veh);
      if (n.waiting.includes(veh)) n.waiting = n.waiting.filter((x) => x !== veh);
    }
    veh.waitingAt = null;
  }

  private revokeGrant(veh: Vehicle): void {
    if (!veh.granted) return;
    const m = this.net.movements.get(veh.granted);
    const node = m && this.net.nodes.get(m.node);
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
    for (const veh of list) {
      if (this.vehicles.has(veh.id)) this.integrate(veh, accel.get(veh)!, dt);
    }
    for (const veh of list) {
      if (!this.vehicles.has(veh.id)) continue;
      veh.rerouteTimer -= dt;
      if (veh.rerouteTimer <= 0) {
        veh.rerouteTimer = 4 + jitter(veh.id + this.time) * 2;
        this.dynamicReroute(veh);
      }
    }
  }

  // ---------- Перестроения ----------

  private laneChange(veh: Vehicle, dt: number): void {
    veh.lcCooldown -= dt;
    if (veh.lcCooldown > 0 || veh.granted) return;
    const lane = this.currentLane(veh);
    if (!lane) return;
    const link = this.net.links.get(lane.link);
    if (!link || link.lanes.length < 2) return;
    const next = veh.routeIndex < veh.route.length - 1 ? veh.route[veh.routeIndex + 1] : undefined;
    const ok = (l: Lane) => next === undefined || this.hasTransition(l, next);
    const remaining = lane.length - veh.s;
    let target: Lane | undefined;
    let mandatory = false;
    if (!ok(lane)) {
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
    const urgency = mandatory ? Math.max(0, Math.min(1, 1 - remaining / 140)) : 0;
    if (this.safeToEnter(target, veh, urgency)) {
      this.moveToLane(veh, lane, target);
      veh.lcCooldown = mandatory ? 0.5 : 3;
    } else {
      veh.lcCooldown = 0.2;
    }
  }

  private freeAhead(lane: Lane, s: number): number {
    let best = Infinity;
    for (const o of lane.vehicles) if (o.s >= s) best = o.s - o.length - s;
    return Math.min(best, lane.length - s + 30);
  }

  private safeToEnter(target: Lane, veh: Vehicle, urgency: number): boolean {
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
    if (veh.s - veh.length < 6) {
      for (const m of this.net.movesInto.get(target.id) ?? []) {
        for (const o of m.vehicles) if (m.length - o.s < 8) return false;
      }
    }
    return true;
  }

  private moveToLane(veh: Vehicle, from: Lane, to: Lane): void {
    from.vehicles = from.vehicles.filter((x) => x !== veh);
    insertSorted(to.vehicles, veh);
    veh.lateral += from.offset - to.offset;
    veh.lane = to.id;
    veh.planned = null;
    if (veh.waitingAt !== null) this.releaseNode(veh);
    const behind = to.vehicles[to.vehicles.indexOf(veh) + 1];
    if (behind?.granted) this.revokeGrant(behind);
  }

  // ---------- Движение ----------

  /** Выбирает манёвр в ближайшем узле с учётом следующего поворота. */
  private pickMovement(veh: Vehicle, lane: Lane): Movement | undefined {
    if (veh.granted) return this.net.movements.get(veh.granted);
    const next = veh.route[veh.routeIndex + 1];
    if (next === undefined) return undefined;
    const after = veh.route[veh.routeIndex + 2];
    let best: Movement | undefined;
    let bestScore = Infinity;
    for (const m of this.net.movesFrom.get(lane.id) ?? []) {
      if (m.outLink !== next) continue;
      const out = this.net.lanes.get(m.outLane);
      if (!out) continue;
      let score = out.vehicles.length * 3 + m.vehicles.length * 2;
      if (after !== undefined && !this.hasTransition(out, after)) score += 40;
      if (m.key === veh.planned) score -= 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    veh.planned = best?.key ?? null;
    return best;
  }

  private computeAccel(veh: Vehicle, dt: number): number {
    const aMax = veh.accel;
    if (veh.onMovement) {
      const m = this.net.movements.get(veh.onMovement)!;
      const idx = m.vehicles.indexOf(veh);
      let gap = Infinity;
      let leaderV = 0;
      if (idx > 0) {
        const leader = m.vehicles[idx - 1];
        gap = leader.s - leader.length - veh.s;
        leaderV = leader.v;
      } else {
        const out = this.net.lanes.get(m.outLane);
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
    if (idx > 0) {
      // Впереди оказалась другая машина (въехала в полосу) — разрешение и место в очереди
      // на узел отдаём: иначе она может ждать нас, а мы — её. Получится вечная пробка.
      if (veh.granted) this.revokeGrant(veh);
      if (veh.waitingAt !== null) this.releaseNode(veh);
      const leader = lane.vehicles[idx - 1];
      return idmAccel(veh.v, desired, leader.s - leader.length - veh.s, veh.v - leader.v, aMax);
    }

    const remaining = lane.length - veh.s;
    if (veh.routeIndex === veh.route.length - 1) {
      return idmAccel(veh.v, desired, remaining + IDM.minGap + 1.5, veh.v, aMax);
    }

    const m = this.pickMovement(veh, lane);
    if (!m) {
      if (remaining < 2 && veh.v < 0.5) {
        veh.stuckTimer += dt;
        if (veh.stuckTimer > 4) this.escapeWrongLane(veh, lane);
      }
      return idmAccel(veh.v, desired, remaining + IDM.minGap - 0.5, veh.v, aMax);
    }
    veh.stuckTimer = 0;
    desired = Math.min(desired, Math.sqrt(m.speed * m.speed + IDM.brake * remaining));
    if (veh.granted !== m.key && remaining <= this.grantLookahead(veh, m)) this.tryGrant(veh, m);

    let gap: number;
    let leaderV = 0;
    if (veh.granted === m.key) {
      gap = Infinity;
      const lastOnM = m.vehicles[m.vehicles.length - 1];
      if (lastOnM) {
        gap = remaining + lastOnM.s - lastOnM.length;
        leaderV = lastOnM.v;
      } else {
        const out = this.net.lanes.get(m.outLane);
        const last = out?.vehicles[out.vehicles.length - 1];
        if (last) {
          gap = remaining + m.length + last.s - last.length;
          leaderV = last.v;
        }
      }
    } else {
      gap = remaining + IDM.minGap - 0.5;
    }
    return idmAccel(veh.v, desired, gap, veh.v - leaderV, aMax);
  }

  /**
   * За сколько до узла просить проезд. Пока проезда нет, узел для машины — как стоп-линия,
   * и модель следования начинает тормозить задолго до неё. Поэтому на стыках без конфликтов
   * и на главной дороге проезд просим заранее, с запасом на всю зону торможения, —
   * машины проходят их без замедления. На перекрёстках и переездах — ближе, чтобы не держать узел.
   */
  private grantLookahead(veh: Vehicle, m: Movement): number {
    const stop = (veh.v * veh.v) / (2 * IDM.brake * 0.6) + 6;
    const node = this.net.node(m.node);
    const through = (m.conflicts.size === 0 || node.priorityLanes.has(m.inLane)) && node.control !== 'lights';
    if (!through || this.net.isCrossing(node)) return Math.max(stop, 8);
    const sStar = IDM.minGap + veh.v * IDM.headway + (veh.v * veh.v) / (2 * Math.sqrt(veh.accel * IDM.brake));
    return Math.max(stop, sStar * 3, 8);
  }

  /** Машина застряла не в той полосе: ищем объезд из текущей полосы. */
  private escapeWrongLane(veh: Vehicle, lane: Lane): void {
    veh.stuckTimer = 0;
    const exits = new Set<number>();
    for (const m of this.net.movesFrom.get(lane.id) ?? []) exits.add(m.outLink);
    const starts = [...exits].map((id) => this.net.links.get(id)!).filter(Boolean);
    const rest = findRoute(this.net, starts, veh.targetNode);
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
      const m = this.net.movements.get(veh.onMovement)!;
      if (veh.s >= m.length) {
        m.vehicles = m.vehicles.filter((x) => x !== veh);
        const node = this.net.node(m.node);
        node.reserved = node.reserved.filter((x) => x !== veh);
        veh.s -= m.length;
        veh.onMovement = null;
        veh.planned = null;
        veh.routeIndex++;
        veh.lane = m.outLane;
        insertSorted(this.net.lanes.get(m.outLane)!.vehicles, veh);
      }
    } else {
      const lane = this.currentLane(veh)!;
      const isLast = veh.routeIndex === veh.route.length - 1;
      if (isLast && veh.s >= lane.length - 0.5) {
        if (this.events.canArrive && !this.events.canArrive(veh)) {
          veh.s = lane.length - 0.5;
          veh.v = 0;
        } else {
          this.arrivals++;
          this.totalTripTime += veh.tripTime;
          this.remove(veh);
          this.events.onArrive(veh);
          return;
        }
      } else if (veh.s >= lane.length) {
        const m = veh.granted ? this.net.movements.get(veh.granted) : undefined;
        if (m && lane.vehicles[0] === veh) {
          lane.vehicles.shift();
          veh.s -= lane.length;
          veh.onMovement = m.key;
          veh.granted = null;
          m.vehicles.push(veh);
        } else {
          veh.s = lane.length;
          veh.v = 0;
        }
      }
    }
    this.updatePose(veh);
  }

  /**
   * Курс кузова: задняя ось тянется за передней на длину базы, как у настоящей машины.
   * Тогда на повороте корма срезает угол внутрь, а не заносится вокруг переднего бампера.
   * После скачка (появление, перенос при разрезании дороги) база ставится по траектории.
   */
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
      const m = this.net.movements.get(veh.onMovement);
      if (!m) return;
      const p = Network.pointOnMovement(m, veh.s);
      veh.pos = p.pos;
      this.steer(veh, p.dir);
      veh.level = this.net.node(m.node).level;
      return;
    }
    const lane = this.currentLane(veh);
    if (!lane) return;
    const pose = this.net.lanePose(lane, Math.min(veh.s, lane.length));
    veh.pos = { x: pose.pos.x - pose.dir.y * veh.lateral, y: pose.pos.y + pose.dir.x * veh.lateral };
    this.steer(veh, pose.dir);
    veh.level = this.net.laneLevel(lane, veh.s);
    const seg = this.net.segment(lane.seg);
    const travel = lane.sStart + veh.s;
    veh.centerS = lane.dir === 0 ? travel : seg.length - travel;
  }

  // ---------- Проезд узлов ----------

  private tryGrant(veh: Vehicle, m: Movement): boolean {
    const node = this.net.node(m.node);
    if (veh.waitingAt !== node.id) {
      if (veh.waitingAt !== null) this.releaseNode(veh);
      veh.waitingAt = node.id;
      veh.requestTime = this.time;
      node.waiting.push(veh);
    }
    // Закрытый переезд — как красный свет: ждём, пока пройдёт поезд.
    veh.ready = !node.crossingClosed && this.hasSpace(node, m, veh) && this.lightAllows(node, m);
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
      const ok = this.vehicles.has(w.id) && !w.onMovement && w.waitingAt === node.id && !!lane && lane.vehicles[0] === w && lane.to === node.id;
      if (!ok && w.waitingAt === node.id) w.waitingAt = null;
      return ok;
    });

    for (const r of node.reserved) {
      const rKey = r.onMovement ?? r.granted;
      if (!rKey || rKey === m.key) continue;
      const kind = m.conflicts.get(rKey);
      if (!kind) continue;
      if (kind === 'diverge' && r.onMovement && r.s > r.length + 3) continue;
      return false;
    }

    const isPriority = node.priorityLanes.has(m.inLane);
    if (node.priorityLanes.size && !isPriority && this.mustYield(node, m, this.time - veh.requestTime)) return false;

    for (const w of node.waiting) {
      if (w === veh || !w.ready || w.requestTime >= veh.requestTime - 0.05) continue;
      if (isPriority && !node.priorityLanes.has(w.lane)) continue;
      const wKey = w.planned;
      if (wKey && wKey !== m.key && m.conflicts.has(wKey)) return false;
    }

    veh.granted = m.key;
    node.waiting = node.waiting.filter((x) => x !== veh);
    veh.waitingAt = null;
    node.reserved.push(veh);
    return true;
  }

  /**
   * Уступить главной: кто-то на ней скоро въедет в узел наперерез. Стоящие в пробке
   * не в счёт (их всё равно не пустит бронь узла), а кто ждёт долго — соглашается на меньший разрыв.
   */
  private mustYield(node: RoadNode, m: Movement, waited: number): boolean {
    const range = waited > 15 ? 12 : 24;
    const headway = waited > 15 ? 0.9 : 1.3;
    const checked = new Set<number>();
    for (const pl of node.priorityLanes) {
      for (const { veh, distance } of this.upstream(pl, range + 40)) {
        if (checked.has(veh.id)) continue;
        checked.add(veh.id);
        if (veh.v < 1 && !veh.onMovement) continue;
        if (distance > range + veh.v * headway) continue;
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
      const lane = this.net.lanes.get(id);
      if (!lane || offset > maxDist || depth > 4) return;
      for (const veh of lane.vehicles) result.push({ veh, distance: offset + lane.length - veh.s });
      const base = offset + lane.length;
      for (const mv of this.net.movesInto.get(id) ?? []) {
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
      const link = this.net.links.get(veh.route[i]);
      if (link?.to !== nodeId) continue;
      if (i === veh.routeIndex && !veh.onMovement) {
        const key = veh.granted ?? veh.planned;
        if (key) return [key];
      }
      return (this.net.transitions.get(`${veh.route[i]}>${veh.route[i + 1]}`) ?? []).map((mv) => mv.key);
    }
    return [];
  }

  private hasSpace(node: RoadNode, m: Movement, veh: Vehicle): boolean {
    const out = this.net.lanes.get(m.outLane);
    if (!out) return false;
    let committed = 0;
    for (const r of node.reserved) {
      const rKey = r.onMovement ?? r.granted;
      const rm = rKey ? this.net.movements.get(rKey) : undefined;
      if (rm && rm.outLane === out.id) committed += r.length + IDM.minGap;
    }
    const last = out.vehicles[out.vehicles.length - 1];
    const free = last ? last.s - last.length : out.length + veh.length + IDM.minGap;
    return free - committed >= (veh.length + IDM.minGap) * 0.6;
  }

  private lightAllows(node: RoadNode, m: Movement): boolean {
    if (!node.lights) return true;
    if (node.lights.clearing) return false;
    return node.lights.phases[node.lights.phase].includes(m.inLane);
  }

  private phaseDemand(phase: number[]): number {
    let demand = 0;
    for (const id of phase) {
      const lane = this.net.lanes.get(id);
      if (!lane) continue;
      for (const veh of lane.vehicles) if (lane.length - veh.s < 70) demand++;
    }
    return demand;
  }

  private updateLights(dt: number): void {
    for (const node of this.net.nodes.values()) {
      const L = node.lights;
      if (!L) continue;
      L.timer -= dt;
      if (L.timer > 0) continue;
      const adaptive = node.adaptive !== false;
      if (L.clearing) {
        L.clearing = false;
        // Умный светофор пропускает пустые фазы, по таймеру — идёт строго по кругу.
        for (let i = 1; i <= L.phases.length; i++) {
          const p = (L.phase + i) % L.phases.length;
          if (!adaptive || this.phaseDemand(L.phases[p]) > 0 || i === L.phases.length) {
            L.phase = p;
            break;
          }
        }
        L.timer = node.greens?.[L.phase] ?? LIGHTS.green;
      } else if (adaptive && !L.phases.some((p, i) => i !== L.phase && this.phaseDemand(p) > 0)) {
        L.timer = 2;
      } else {
        L.clearing = true;
        L.timer = LIGHTS.clearance;
      }
    }
  }

  // ---------- Маршруты ----------

  private dynamicReroute(veh: Vehicle): void {
    if (veh.onMovement || veh.granted || veh.routeIndex >= veh.route.length - 1) return;
    const lane = this.currentLane(veh);
    const link = lane && this.net.links.get(lane.link);
    if (!link) return;
    const route = findRoute(this.net, [link], veh.targetNode);
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

  /** Убирает все машины с сегмента (например, перед разворотом его направления). */
  evictSegment(segId: number): void {
    for (const veh of [...this.vehicles.values()]) {
      const lane = this.currentLane(veh);
      const m = veh.onMovement ? this.net.movements.get(veh.onMovement) : undefined;
      const outSeg = m ? this.net.lanes.get(m.outLane)?.seg : undefined;
      if (lane?.seg === segId || outSeg === segId) this.lose(veh);
    }
  }

  /** Чинит машины после перестройки сети: переносит, перестраивает маршруты или убирает. */
  validate(): void {
    const splits = new Map<number, SplitRecord>();
    for (const rec of this.net.pendingSplits) splits.set(rec.oldSeg, rec);
    this.net.pendingSplits = [];

    for (const veh of [...this.vehicles.values()]) {
      if (veh.onMovement && !this.net.movements.has(veh.onMovement)) {
        // Манёвр исчез: ставим машину в начало полосы, куда она ехала.
        const [, outId] = veh.onMovement.split('>').map(Number);
        const out = decodeLane(outId);
        this.detach(veh);
        veh.onMovement = null;
        veh.lane = outId;
        veh.centerS = out.dir === 0 ? 0 : (splits.get(out.seg)?.oldLength ?? this.net.segments.get(out.seg)?.length ?? 0);
        veh.routeIndex++;
        if (!this.relocate(veh, splits)) continue;
      } else if (!veh.onMovement && !this.net.lanes.has(veh.lane)) {
        this.detach(veh);
        if (!this.relocate(veh, splits)) continue;
      } else if (!veh.onMovement) {
        const lane = this.currentLane(veh)!;
        veh.s = Math.min(veh.s, lane.length);
      }
      if (veh.granted && !this.net.movements.has(veh.granted)) {
        veh.granted = null;
        this.releaseNode(veh);
      }
      this.repairRoute(veh, splits);
    }
  }

  private detach(veh: Vehicle): void {
    for (const lane of this.net.lanes.values()) {
      if (lane.vehicles.includes(veh)) lane.vehicles = lane.vehicles.filter((x) => x !== veh);
    }
    for (const m of this.net.movements.values()) {
      if (m.vehicles.includes(veh)) m.vehicles = m.vehicles.filter((x) => x !== veh);
    }
    this.releaseNode(veh);
    veh.granted = null;
    veh.planned = null;
  }

  /** Переносит машину на полосу нового сегмента после разрезания. */
  private relocate(veh: Vehicle, splits: Map<number, SplitRecord>): boolean {
    let { seg, dir, index } = decodeLane(veh.lane);
    let cs = veh.centerS;
    while (splits.has(seg)) {
      const rec = splits.get(seg)!;
      if (cs < rec.at) seg = rec.first;
      else {
        seg = rec.second;
        cs -= rec.at;
      }
    }
    const link = this.net.links.get(linkId(seg, dir));
    const s = this.net.segments.get(seg);
    if (!link || !s) {
      this.lose(veh);
      return false;
    }
    const lane = link.lanes[Math.min(index, link.lanes.length - 1)];
    const travel = dir === 0 ? cs : s.length - cs;
    veh.lane = lane.id;
    veh.s = Math.max(0, Math.min(lane.length, travel - lane.sStart));
    veh.lateral = 0;
    insertSorted(lane.vehicles, veh);
    this.updatePose(veh);
    return true;
  }

  private expandLink(id: number, splits: Map<number, SplitRecord>): number[] {
    const seg = Math.floor(id / 2);
    const dir = (id % 2) as 0 | 1;
    const rec = splits.get(seg);
    if (!rec) return [id];
    const a = this.expandLink(linkId(rec.first, dir), splits);
    const b = this.expandLink(linkId(rec.second, dir), splits);
    return dir === 0 ? [...a, ...b] : [...b, ...a];
  }

  private repairRoute(veh: Vehicle, splits: Map<number, SplitRecord>): void {
    if (!this.vehicles.has(veh.id)) return;
    const lane = this.currentLane(veh);
    if (!lane) {
      this.lose(veh);
      return;
    }
    let route = veh.route.slice(veh.routeIndex).flatMap((id) => this.expandLink(id, splits));
    const cur = route.indexOf(lane.link);
    route = cur >= 0 ? route.slice(cur) : [lane.link, ...route];
    veh.route = route;
    veh.routeIndex = 0;
    if (this.routeValid(veh)) return;

    let fresh: number[] | null;
    if (veh.onMovement) {
      const m = this.net.movements.get(veh.onMovement)!;
      const rest = findRoute(this.net, [this.net.links.get(m.outLink)!], veh.targetNode);
      fresh = rest ? [lane.link, ...rest] : null;
    } else {
      fresh = findRoute(this.net, [this.net.links.get(lane.link)!], veh.targetNode);
    }
    if (!fresh) {
      this.lose(veh);
      return;
    }
    this.setRoute(veh, fresh);
  }

  private routeValid(veh: Vehicle): boolean {
    const r = veh.route;
    for (let i = veh.routeIndex; i < r.length; i++) {
      if (!this.net.links.has(r[i])) return false;
      if (i > veh.routeIndex && !this.net.linkNext.get(r[i - 1])?.has(r[i])) return false;
    }
    const last = this.net.links.get(r[r.length - 1]);
    return !!last && last.to === veh.targetNode;
  }

  private lose(veh: Vehicle): void {
    this.remove(veh);
    this.events.onLost(veh);
  }
}

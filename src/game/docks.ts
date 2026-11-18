import { add, dist, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import type { GLane, LaneGraph } from '../lanes/graph';
import type { LaneNet } from '../lanes/model';
import { findLaneRoute } from '../lanes/routing';
import type { LaneTraffic } from '../lanes/traffic';
import { boxesOverlap, type Box } from '../lanes/curb';
import type { Vehicle, VehicleSpec } from '../sim/vehicle';
import { follow, hitchOf, jointOf, vehicleBoxes, type VehicleBody } from '../sim/body';
import type { TownBuilding } from '../world/entities';
import { lotFrame, type Driveway } from '../world/houseAccess';
import { DOCK_TRUCK, dockDriveway, dockSolidsOf, dockYardsOf, exitDriveway, RAMP_GAP, THROUGH_R, type DockYard } from '../world/shopLots';
import { laneSlot, type GarageSlot } from './garages';
import { advance, bezier, decideNow, entrySpeed, handOff, joinLane, legPose, poseSim, reversed, runOf, runPose, straight, type Leg, type Run } from './lotMoves';
import { dockPathLeg, planDockPath } from './dockPath';

/**
 * Грузовик у получателя (docs/RETAIL.md, «Заезд во двор»; world/retail.ts): маршрут кончается связью у его двора
 * (Vehicle.endLink), грузовик замедляется, с поворотником подъезжает к проезду на скорости поворота в него
 * (LaneTraffic.slowTo, lotMoves.entrySpeed) и сворачивает с ходу, передом; двор занят машиной покупателя на манёвре —
 * встаёт напротив проезда (holdAfter) и ждёт. Пока кузов над полосой, он в потоке (стоит, его объезжают), дальше — во
 * дворе, только рисунок. Двор 'turn' (world/shopLots.DockYard): по проезду за здание, поворот, задом к рампе на
 * задней стене; выгрузка; разворот к проезду, передом к бордюру и, если на полосе настоящий просвет
 * (LaneTraffic.clearToJoin), не останавливаясь, направо в поток; нет просвета — ждёт его у бордюра. Двор 'back'
 * (мелкий, рампа у торца, склад): передом по проезду до рампы, выезд задним ходом на полосу, как из гаража.
 * Двор 'through' (АЗС, оптовая база): въезд в съезд, к которому полоса подходит первой, проезд вдоль улицы до рампы,
 * выезд из другого съезда передом направо — без заднего хода.
 *
 * Рампа занята — второй грузовик к ней не едет (game.ts: ждёт на прошлой остановке, потом пропускает получателя); у
 * рынка рамп две (world/shopLots.dockYardsOf) — к свободной (freeRamp), вторая — только с той же связи улицы. Двор
 * общий с машинами покупателей на стоянке (game/shopParking.ts): пока одна из них на манёвре, грузовик не начинает
 * свой, а пока грузовик на манёвре во дворе — они ждут (DockHost.lotBusy, Docks.yardBusy).
 *
 * Манёвры не сохраняются (как у гаражей): грузовик во дворе в сохранении — на остановке; после загрузки он встаёт у
 * рампы и выезжает от неё.
 */
export const DOCK = {
  /**
   * Скорости манёвра, ед./с игры: с полосы в проезд, по двору передом и задом, на полосу; разгон и торможение. Передом
   * по двору ~10 км/ч, задом ~6,5: при 3 и 2 ед./с заезд и выезд шли по 20 с, визит к магазину — почти месяц (60 с).
   */
  speed: { roadIn: 5.5, yardIn: 4.5, yardBack: 3, roadOut: 5, accel: 3.5, brake: 4.5 },
  /** За столько метров до проезда грузовик сбрасывает скорость до slow (м/с игры) — скоро поворачивать. */
  slowAt: 80,
  slow: 7,
  /** Поворотник — за столько метров. */
  blinkAt: 50,
  /** Мягкое торможение к проезду, м/с² игры: позже уже не остановиться — проезжает мимо. */
  hold: 6,
  /**
   * Ждущий просвета у бордюра смотрит по сторонам хотя бы столько, с; встав на полосу задним ходом (двор 'back') —
   * столько до того, как тронуться вперёд.
   */
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
  /** Какая рампа дома (world/shopLots.dockYardsOf): у рынка их две. */
  k: number;
  /** Середина кузова у бордюра: корма у полотна (въехал передом) или нос у полотна (ждёт выезда). */
  curbSide: Vec;
  /** Сквозной двор ('through'): второй проезд — выезд, и середина кузова у бордюра перед выездом (нос к улице). */
  exitD?: Driveway;
  exitSide?: Vec;
  in: GarageSlot | null;
  /**
   * Выезд на полосу: 'turn' — передом направо дальше по ходу; 'back' — задом, как въезжал (то же место, что in);
   * 'through' — передом направо из второго проезда, дальше по ходу.
   */
  out: OutSlot | null;
  /** Середина кузова и курс у рампы. */
  ramp: { c: Vec; h: Vec };
  /** Двор: от бордюра до рампы и от рампы до бордюра (у полотна — нос к улице или корма к ней). */
  inLegs: Leg[];
  outLegs: Leg[];
  /** Полный путь сцепки: дорожная дуга и двор, с выровненными кузовами у рампы. */
  entry?: Leg[];
  departure?: Leg[];
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
  /** К какой рампе дома (у рынка их две): выбирает свободную, пока не у проезда. */
  k: number;
  /** Уже у проезда (сбросил скорость): рампа — за ним, другому грузовику туда не сворачивать. */
  close?: boolean;
  /** Двор был свободен — сворачивает с ходу, двор уже за ним (yardBusy): покупателям туда не заезжать. */
  roll?: boolean;
}

/** Грузовик на манёвре: отрезки по порядку и где на них (run), машина в потоке (пока кузов над полосой). */
interface Move {
  id: number;
  geo: DockGeo;
  kind: 'in' | 'out';
  /** legs — по двору; wait — у бордюра ждёт просвета; join — встаёт на полосу; pause — встал задом, сейчас тронется. */
  phase: 'legs' | 'wait' | 'join' | 'pause';
  run: Run;
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
  /** Положение сцепки сохраняется и после снятия машины с дорожного графа. */
  private bodies = new Map<number, { body?: VehicleBody; trail?: Vec }>();

  constructor(private host: DockHost) {}

  /**
   * Двор дома b (рампа k, у рынка их две) для грузовика длины L и ширины W на нынешнем графе; двора нет или к нему не
   * подъехать — null.
   */
  geoOf(b: TownBuilding, L: number = DOCK_TRUCK.l, W: number = DOCK_TRUCK.w, k = 0): DockGeo | null {
    const g = this.host.graph;
    if (this.geoGraph !== g) {
      this.geos.clear();
      this.geoGraph = g;
    }
    const key = `${b.id}:${L}:${W}:${k}:${b.form}:${b.floors}:${b.face}:${b.fp.center.x}:${b.fp.center.y}:${b.fp.w}:${b.fp.h}:${b.fp.angle}:${b.dockApproach ?? 'front'}`;
    const hit = this.geos.get(key);
    if (hit !== undefined && (hit === null || (hit.b === b && hit.fp === b.fp))) return hit;
    const geo = this.compute(b, L, W, g, k);
    this.geos.set(key, geo);
    return geo;
  }

  /** Рампы дома b, занятые другими грузовиками (не except): на манёвре, у рампы или уже сворачивают к ней. */
  private rampsTaken(b: number, except?: number): Set<number> {
    const out = new Set<number>();
    for (const m of this.moves.values()) if (m.id !== except && m.geo.b.id === b) out.add(m.geo.k);
    for (const [id, geo] of this.parked) if (id !== except && geo.b.id === b) out.add(geo.k);
    for (const h of this.homing.values()) if (h.id !== except && h.b.id === b && h.close) out.add(h.k);
    return out;
  }

  /**
   * Свободная рампа дома b для грузовика except длины L: первая не занятая другими, к которой подъехать; вторая (у
   * рынка) — только с той же связи, что и первая (путь к двору кончается ею). Все заняты — null.
   */
  freeRamp(b: TownBuilding, except?: number, L: number = DOCK_TRUCK.l, W: number = DOCK_TRUCK.w): number | null {
    const taken = this.rampsTaken(b.id, except);
    const n = dockYardsOf(b).length;
    const first = this.geoOf(b, L, W, 0);
    for (let k = 0; k < n; k++) {
      if (taken.has(k)) continue;
      const geo = k === 0 ? first : this.geoOf(b, L, W, k);
      if (!geo?.in || !geo.out) continue;
      if (k > 0 && (!first?.in || geo.in.link.id !== first.in.link.id)) continue;
      return k;
    }
    return null;
  }

  /** Сколько рамп у дома b, к которым грузовик длины L подъедет (у рынка — до двух). */
  rampCount(b: TownBuilding, L: number = DOCK_TRUCK.l, W: number = DOCK_TRUCK.w): number {
    const first = this.geoOf(b, L, W, 0);
    if (!first?.in || !first.out) return 0;
    let n = 1;
    for (let k = 1; k < dockYardsOf(b).length; k++) {
      const geo = this.geoOf(b, L, W, k);
      if (geo?.in && geo.out && geo.in.link.id === first.in.link.id) n++;
    }
    return n;
  }

  /** Можно ли грузовику длины L заехать во двор и выехать. */
  reachable(b: TownBuilding, L: number = DOCK_TRUCK.l, W: number = DOCK_TRUCK.w): boolean {
    const geo = this.geoOf(b, L, W);
    return !!geo?.in && !!geo.out;
  }

  private compute(b: TownBuilding, L: number, W: number, g: LaneGraph, k: number): DockGeo | null {
    const yard = dockYardsOf(b)[k] ?? null;
    let d = dockDriveway(b, yard);
    if (!yard || !d) return null;
    const at = lotFrame(b);
    const o = at(0, 0);
    const X = sub(at(1, 0), o);
    const Y = d.dir;
    let curbSide = add(d.curb, scale(Y, L / 2 + 0.3));
    let slot = laneSlot(g, this.host.net, d, curbSide, L, W);
    const sp = DOCK.speed;
    let ramp: { c: Vec; h: Vec };
    let inLegs: Leg[];
    let outLegs: Leg[];
    let out: OutSlot | null = null;
    let exitD: Driveway | undefined;
    let exitSide: Vec | undefined;
    /** Выезд направо передом в sideAt (середина кузова у бордюра), дальше по ходу полосы въезда: зеркально повороту с неё. */
    const rightOut = (sideAt: Vec): OutSlot | null => {
      if (!slot) return null;
      const rel = sub(sideAt, slot.pos);
      const along = dot(rel, slot.f);
      const lat = Math.abs(dot(rel, rightNormal(slot.f)));
      const mid = slot.mid + along + lat;
      const zone: [number, number] = [slot.mid + along - W / 2 - 1, mid + L / 2 + 0.5];
      if (zone[0] < END_ROOM || zone[1] > slot.lane.length - END_ROOM) return null;
      const p = g.lanePose(slot.lane, mid);
      return { lane: slot.lane, mid, zone, pos: p.pos, f: p.dir };
    };
    if (yard.kind === 'through') {
      // Сквозной двор: въезд — тот проезд, к которому полоса подходит первой (участок симметричен), выезд — другой.
      const other = exitDriveway(b, yard);
      if (!other) return null;
      const sgn = slot && dot(slot.f, X) < 0 ? -1 : 1;
      if (sgn === -1) {
        exitD = d;
        d = other;
        curbSide = add(d.curb, scale(Y, L / 2 + 0.3));
        slot = laneSlot(g, this.host.net, d, curbSide, L, W);
      } else exitD = other;
      exitSide = add(exitD.curb, scale(Y, L / 2 + 0.3));
      const xi = sgn === 1 ? yard.drive.x : yard.exit!.x;
      const xo = sgn === 1 ? yard.exit!.x : yard.drive.x;
      const R = THROUGH_R;
      const kk = 0.55 * R;
      const Xs = scale(X, sgn);
      const lane = yard.wall;
      const E = at(xi, lane - R);
      const P = at(xi + sgn * R, lane);
      const F = at(yard.rx, lane);
      const Q = at(xo - sgn * R, lane);
      const G = at(xo, lane - R);
      ramp = { c: F, h: Xs };
      inLegs = [];
      if (dist(curbSide, E) > 0.3) inLegs.push(straight(curbSide, E, false, sp.yardIn));
      inLegs.push(bezier(E, add(E, scale(Y, kk)), sub(P, scale(Xs, kk)), P, false, sp.yardIn));
      if (dist(P, F) > 0.3) inLegs.push(straight(P, F, false, sp.yardIn));
      outLegs = [];
      if (dist(F, Q) > 0.3) outLegs.push(straight(F, Q, false, sp.yardIn));
      outLegs.push(bezier(Q, add(Q, scale(Xs, kk)), add(G, scale(Y, kk)), G, false, sp.yardIn));
      if (dist(G, exitSide) > 0.3) outLegs.push(straight(G, exitSide, false, sp.yardIn));
      out = rightOut(exitSide);
    } else if (yard.kind === 'turn') {
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
      // Два четверть-круга и прямая между ними: касательные непрерывны, радиус не сжимается до половины узкого зазора.
      const A = at(yard.rx + s * R, fy + R);
      const B = at(yard.drive.x - s * R, fy + R);
      outLegs = [bezier(F, add(F, scale(Y, k)), sub(A, scale(X, s * k)), A, false, sp.yardIn)];
      if (dist(A, B) > 0.3) outLegs.push(straight(A, B, false, sp.yardIn));
      outLegs.push(bezier(B, add(B, scale(X, s * k)), add(E, scale(Y, k)), E, false, sp.yardIn), straight(E, curbSide, false, sp.yardIn));
      out = rightOut(curbSide);
    } else {
      const F = at(yard.drive.x, yard.drive.y1 - L / 2 - 0.4);
      ramp = { c: F, h: Y };
      inLegs = [straight(curbSide, F, false, sp.yardIn)];
      outLegs = [straight(F, curbSide, true, sp.yardBack)];
      if (slot) out = { lane: slot.lane, mid: slot.mid, zone: slot.zone, pos: slot.pos, f: slot.f };
    }
    const geo: DockGeo = { b, fp: b.fp, yard, d, L, W, k, curbSide, exitD, exitSide, in: slot, out, ramp, inLegs, outLegs };
    return (L > 12 ? this.articulated(geo) : this.fits(geo)) ? geo : null;
  }

  private articulated(geo: DockGeo): boolean {
    if (!geo.in || !geo.out) return false;
    const { b, L, W } = geo;
    const body = L > 18 ? 'longSemi' : 'semi';
    const at = lotFrame(b), origin = at(0, 0);
    const x = sub(at(1, 0), origin), y = sub(at(0, 1), origin);
    const obstacles = dockSolidsOf(b, true).map((r) => ({ c: at(r.x + r.w / 2, r.y + r.h / 2), d: x, hl: r.w / 2, hw: r.h / 2 }));
    const clear = (box: Box) => {
      if (obstacles.some((o) => boxesOverlap(box, o))) return false;
      for (const a of [-1, 1]) for (const z of [-1, 1]) {
        const p = sub({ x: box.c.x + a * box.d.x * box.hl - z * box.d.y * box.hw, y: box.c.y + a * box.d.y * box.hl + z * box.d.x * box.hw }, origin);
        const py = dot(p, y);
        if (py > b.fp.h / 2 || (py > -b.fp.h / 2 && Math.abs(dot(p, x)) > b.fp.w / 2)) return false;
        if (py < -b.fp.h / 2 - 26) return false;
      }
      return true;
    };
    const plan = (start: {c: Vec; h: Vec}, end: {c: Vec; h: Vec}, gate: Vec, heading: Vec) => {
      const direct = planDockPath(start, end, L, W, body, clear);
      if (direct || geo.yard.kind !== 'through') return direct;
      for (const extra of [2, 4, 6, 8]) {
        const middle = { c: add(gate, scale(geo.d.dir, extra)), h: heading };
        const a = planDockPath(start, middle, L, W, body, clear);
        if (!a) continue;
        const b = planDockPath(middle, end, L, W, body, clear);
        if (b) return [...a.slice(0, -1), ...b];
      }
      return null;
    };
    const entry = plan({ c: geo.in.pos, h: geo.in.f }, geo.ramp, geo.curbSide, geo.d.dir);
    if (!entry) return false;
    let split = entry.findIndex((p) => dot(sub(p.c, geo.d.curb), geo.d.dir) > L / 2 + 1);
    split = Math.max(1, Math.min(entry.length - 2, split));
    geo.entry = [dockPathLeg(entry.slice(0, split + 1), DOCK.speed.roadIn), dockPathLeg(entry.slice(split), DOCK.speed.yardIn)];
    if (geo.yard.kind === 'back') {
      geo.departure = [...geo.entry].reverse().map((l) => reversed(l, true, DOCK.speed.yardBack));
    } else {
      const out = plan(geo.ramp, { c: geo.out.pos, h: geo.out.f }, geo.exitSide ?? geo.curbSide, scale(geo.d.dir, -1));
      if (!out) return false;
      let edge = out.findIndex((p) => dot(sub(p.c, (geo.exitD ?? geo.d).curb), geo.d.dir) < L / 2 + 1);
      edge = Math.max(1, Math.min(out.length - 2, edge));
      geo.departure = [dockPathLeg(out.slice(0, edge + 1), DOCK.speed.yardIn), dockPathLeg(out.slice(edge), DOCK.speed.roadOut)];
    }
    geo.outLegs = geo.departure.slice(0, -1);
    // Просвет на полосе — по выносу обеих частей новой траектории, а не только по старой дуге центра кузова.
    const hitch = hitchOf(body)!;
    const leg = geo.departure.at(-1)!;
    for (let i = 0; i < leg.pts.length; i++) {
      const p = legPose(leg, leg.cum[i]);
      const nose = add(p.c, scale(p.h, L / 2));
      const trail = sub(jointOf(nose, p.h, L, hitch), scale(p.th!, L * hitch.tail));
      for (const box of vehicleBoxes(nose, p.h, L, W, body, trail)) {
        const mid = geo.out.mid + dot(sub(box.c, geo.out.pos), geo.out.f);
        const reach = Math.abs(dot(box.d, geo.out.f)) * box.hl + Math.abs(dot(rightNormal(box.d), geo.out.f)) * box.hw + 1;
        geo.out.zone[0] = Math.min(geo.out.zone[0], mid - reach);
        geo.out.zone[1] = Math.max(geo.out.zone[1], mid + reach);
      }
    }
    return true;
  }

  /** Проверяем весь кузов, включая вынос кормы; тесный участок не должен давать формально достижимую рампу. */
  private fits(geo: DockGeo): boolean {
    const { b, L, W } = geo;
    const at = lotFrame(b);
    const origin = at(0, 0);
    const x = sub(at(1, 0), origin);
    const y = sub(at(0, 1), origin);
    const obstacles: Box[] = dockSolidsOf(b, true).map((r) => ({ c: at(r.x + r.w / 2, r.y + r.h / 2), d: x, hl: r.w / 2, hw: r.h / 2 }));
    const clear = (leg: Leg, yard: boolean) => {
      for (let i = 0, n = Math.max(1, Math.ceil(leg.len / 0.3)); i <= n; i++) {
        const p = legPose(leg, leg.len * i / n);
        const box = { c: p.c, d: p.h, hl: L / 2 + 0.05, hw: W / 2 + 0.05 };
        if (obstacles.some((o) => boxesOverlap(box, o))) return false;
        if (!yard) continue;
        for (const a of [-1, 1]) for (const z of [-1, 1]) {
          const q = { x: box.c.x + a * box.d.x * box.hl - z * box.d.y * box.hw, y: box.c.y + a * box.d.y * box.hl + z * box.d.x * box.hw };
          const rel = sub(q, origin);
          if (Math.abs(dot(rel, x)) > b.fp.w / 2 + 0.05 || dot(rel, y) > b.fp.h / 2 + 0.05) return false;
        }
      }
      return true;
    };
    for (const legs of [geo.inLegs, geo.outLegs]) for (let i = 0; i < legs.length; i++) {
      if (!clear(legs[i], true)) return false;
      if (i) {
        const prev = legPose(legs[i - 1], legs[i - 1].len);
        const next = legPose(legs[i], 0);
        if (dist(prev.c, next.c) > 0.05 || dot(prev.h, next.h) < 0.99) return false;
      }
    }
    if (dot(legPose(geo.inLegs[0], 0).h, geo.d.dir) < 0.99) return false;
    if (geo.in && !clear(this.turnLeg(geo, geo.in.pos, geo.in.f), false)) return false;
    if (geo.out && !clear(this.outLeg(geo, geo.out), false)) return false;
    return true;
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
    const k = this.freeRamp(b, id, sim.length, sim.width) ?? 0;
    const geo = this.geoOf(b, sim.length, sim.width, k);
    if (!geo?.in || !geo.out) return false;
    sim.endLink = geo.in.link.id;
    this.homing.set(sim.id, { id, b, maxSpeed: sim.maxSpeed, k });
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
   * Все рампы дома b (у рынка их две) заняты другими грузовиками (не except): они во дворе — заезжают, стоят у рампы,
   * выезжают — или уже сбросили скорость перед проездом и сейчас свернут. L, W — грузовик, которому ехать.
   */
  rampBusy(b: TownBuilding, except?: number, L: number = DOCK_TRUCK.l, W: number = DOCK_TRUCK.w): boolean {
    if (!this.rampsTaken(b.id, except).size) return false;
    return this.freeRamp(b, except, L, W) === null;
  }

  /** У дома b грузовик на манёвре (не стоит у рампы) или сворачивает к нему с ходу: машинам покупателей во дворе ждать. */
  yardBusy(b: number): boolean {
    for (const m of this.moves.values()) if (m.geo.b.id === b && m.phase !== 'pause') return true;
    for (const h of this.homing.values()) if (h.roll && h.b.id === b) return true;
    return false;
  }

  occupied(b: number): boolean {
    return this.rampsTaken(b).size > 0;
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
    if (b) geo = this.geoOf(b, spec.length, spec.width, geo?.k ?? 0) ?? geo;
    if (!geo?.out) return false;
    if (!this.bodies.has(id)) this.bodies.set(id, { body: spec.body });
    this.parked.delete(id);
    this.moves.set(id, { id, geo, kind: 'out', phase: 'legs', run: runOf([...geo.outLegs]), wait: 0, road: false, spec, target, endLink, blink: 0 });
    return true;
  }

  /** Грузовик id встаёт к рампе дома b сразу (из сохранения: стоял у неё или был во дворе). */
  stand(id: number, b: TownBuilding, L: number, W: number): boolean {
    this.bodies.delete(id);
    this.moves.delete(id);
    this.parked.delete(id);
    const geo = this.geoOf(b, L, W, this.freeRamp(b, id, L, W) ?? 0);
    if (!geo) return false;
    this.moves.delete(id);
    this.parked.set(id, geo);
    return true;
  }

  /** Грузовика id больше нет (продан, маршрут поменяли): ни манёвра, ни места у рампы. Машину в потоке — отпустить. */
  forget(id: number): void {
    this.bodies.delete(id);
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
      if (!h.close) {
        // Пока не у проезда — к свободной рампе (у рынка их две; вторая — с той же связи, что и первая).
        const free = this.freeRamp(h.b, h.id, sim.length, sim.width);
        if (free !== null) h.k = free;
      }
      const geo = this.geoOf(h.b, sim.length, sim.width, h.k);
      const slot = geo?.out ? geo.in : null;
      if (!geo || !slot || sim.endLink !== slot.link.id) {
        this.cancel(sim, h);
        continue;
      }
      const L = sim.length;
      // Сколько ещё до места, откуда сворачивать (середина кузова — в mid).
      const left = traffic.routeLeft(sim) - (slot.lane.length - (slot.mid + L / 2));
      // Рампы заняты другими грузовиками — не сворачивает, проезжает мимо (игра: объезд квартала и снова, потом — дальше).
      if (!h.close && this.rampBusy(h.b, h.id, sim.length, sim.width)) {
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
        else traffic.slowTo(sim, room, entrySpeed(geo.entry ?? [this.turnLeg(geo, slot.pos, slot.f), ...geo.inLegs], DOCK.speed.brake));
        continue;
      }
      // Двор общий с покупателями: за тормозной путь до проезда смотрит, не на манёвре ли машина у стоянки, — нет:
      // сворачивает с ходу (двор уже за ним, yardBusy); да — встаёт напротив проезда и ждёт.
      if (!h.roll && sim.holdV !== undefined && sim.holdDist <= (sim.v * sim.v) / (2 * DOCK.hold) + 1) {
        if (this.host.lotBusy(h.b.id)) traffic.holdAfter(sim, sim.holdDist);
        else h.roll = true;
      }
      if (!traffic.held(sim)) continue;
      if (sim.lane !== slot.lane.id) {
        this.cancel(sim, h);
        continue;
      }
      if (!h.roll && this.host.lotBusy(h.b.id)) continue;
      this.homing.delete(simId);
      sim.maxSpeed = h.maxSpeed;
      const c0 = sub(sim.pos, scale(sim.dir, L / 2));
      // С ходу — с той скоростью, с какой подъехал; ждал — с места.
      const v0 = sim.holdV !== undefined ? sim.v : 0;
      traffic.holdAfter(sim, 0);
      sim.lcCooldown = 1e9;
      const blink = dot(geo.d.dir, rightNormal(slot.f)) > 0 ? 1 : -1;
      this.bodies.set(h.id, { body: sim.body, trail: sim.trail && { ...sim.trail } });
      this.moves.set(h.id, { id: h.id, geo, kind: 'in', phase: 'legs', run: runOf(geo.entry ? [...geo.entry] : [this.turnLeg(geo, c0, sim.dir), ...geo.inLegs], v0), wait: 0, sim, road: true, blink });
    }
  }

  /** Поворот с полосы в проезд: от середины кузова c0 (курс f) до бордюра, кузов — в проезде. */
  private turnLeg(geo: DockGeo, c0: Vec, f: Vec): Leg {
    const k = 0.55 * Math.max(2, Math.abs(dot(sub(geo.curbSide, c0), rightNormal(f))));
    return bezier(c0, add(c0, scale(f, k)), sub(geo.curbSide, scale(geo.d.dir, k)), geo.curbSide, false, DOCK.speed.roadIn);
  }

  private outLeg(geo: DockGeo, out: OutSlot): Leg {
    if (geo.departure) return geo.departure[geo.departure.length - 1];
    const start = geo.exitSide ?? geo.curbSide;
    const dir = (geo.exitD ?? geo.d).dir;
    const k = 0.55 * Math.max(2, Math.abs(dot(sub(start, out.pos), rightNormal(out.f))));
    return geo.yard.kind === 'back'
      ? bezier(start, sub(start, scale(dir, k)), add(out.pos, scale(out.f, k)), out.pos, true, DOCK.speed.roadOut)
      : bezier(start, sub(start, scale(dir, k)), sub(out.pos, scale(out.f, k)), out.pos, false, DOCK.speed.roadOut);
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
      // Встал на полосу задним ходом, носом по ходу — поехал.
      handOff(traffic, m.sim!);
      this.bodies.delete(m.id);
      return false;
    }
    const r = m.run;
    // Выезд: подъезжая к бордюру, смотрит, есть ли просвет: есть — встаёт в поток с ходу.
    if (m.kind === 'out' && m.phase === 'legs' && r.i === r.legs.length - 1 && decideNow(r, DOCK.speed.brake)) this.join(m, true);
    // Встаёт на полосу передом — дальше едет с той же скоростью.
    const last = r.legs[r.legs.length - 1];
    const end = m.phase === 'join' && !last.back ? last.vmax : 0;
    const over = advance(r, dt, DOCK.speed, end, (i) => {
      if (m.kind !== 'in' || !m.road || i !== 0) return;
      // Кузов ушёл с полосы в проезд — в потоке грузовика больше нет.
      const sim = m.sim!;
      traffic.remove(sim);
      m.sim = undefined;
      m.road = false;
      this.host.gone(m.id, sim);
    });
    this.pose(m);
    return over ? this.legsDone(m) : true;
  }

  /** Все отрезки пройдены: въехал — у рампы; выехал со двора — к бордюру ждать; встал на полосу — дальше сам (задом — после паузы). */
  private legsDone(m: Move): boolean {
    if (m.kind === 'in') {
      this.parked.set(m.id, m.geo);
      this.host.arrived(m.id);
      return false;
    }
    if (m.phase === 'join' && !m.run.legs[m.run.i].back) {
      handOff(this.host.traffic, m.sim!, m.run.v);
      this.bodies.delete(m.id);
      return false;
    }
    m.run.v = 0;
    m.wait = 0;
    m.phase = m.phase === 'join' ? 'pause' : 'wait';
    return true;
  }

  /** У бордюра: настоящий просвет и двор свободен — в поток (стоит, пока выезжает на полосу). */
  private stepWait(m: Move, dt: number): boolean {
    m.wait += dt;
    if (m.wait >= DOCK.look) this.join(m, false);
    return true;
  }

  /**
   * Встаёт в поток, если на полосе выезда настоящий просвет и двор свободен: грузовик в потоке (стоит, пока выезжает)
   * и путь от бордюра на полосу. rolling — ещё подъезжает к бордюру: путь на полосу продолжает его ход. Нельзя — false.
   */
  private join(m: Move, rolling: boolean): boolean {
    const geo = this.geoOf(m.geo.b, m.geo.L, m.geo.W, m.geo.k) ?? m.geo;
    const out = geo.out;
    const traffic = this.host.traffic;
    if (!out || this.host.lotBusy(geo.b.id) || !traffic.clearToJoin(out.lane.id, out.zone[0], out.zone[1])) return false;
    const sim = joinLane(traffic, m.spec!, out.lane.id, out.mid + geo.L / 2, m.target!, m.endLink);
    if (!sim) return false;
    // Сквозной двор — из второго проезда.
    const dir = (geo.exitD ?? geo.d).dir;
    const back = geo.yard.kind === 'back';
    // 'turn' и 'through' — передом направо, 'back' — задом, как из гаража (нос по ходу полосы в конце).
    const leg = this.outLeg(geo, out);
    m.geo = geo;
    m.sim = sim;
    m.phase = 'join';
    if (rolling) m.run.legs.push(leg);
    else m.run = runOf([leg]);
    m.blink = back ? 0 : dot(out.f, rightNormal(scale(dir, -1))) > 0 ? 1 : -1;
    this.pose(m);
    this.host.joined(m.id, sim);
    return true;
  }

  /** Машина в потоке на манёвре — там, где она на нём (поток держит её на месте: holdAfter). */
  private pose(m: Move): void {
    const body = this.bodies.get(m.id);
    const { c, h, th } = runPose(m.run);
    const nose = add(c, scale(h, m.geo.L / 2));
    const hitch = body && hitchOf(body.body);
    if (body && hitch) {
      const joint = jointOf(nose, h, m.geo.L, hitch);
      const length = m.geo.L * hitch.tail;
      body.trail = th ? sub(joint, scale(th, length)) : follow(joint, h, body.trail, length);
    }
    if (m.sim) {
      poseSim(m.sim, m.run, m.blink);
      if (body?.trail) m.sim.trail = { ...body.trail };
    }
  }

  /**
   * Где грузовик id во дворе (не в потоке): нос и курс — на манёвре или у рампы; в потоке (кузов над полосой) или не
   * во дворе — null.
   */
  poseOf(id: number): { pos: Vec; dir: Vec; trail?: Vec } | null {
    const m = this.moves.get(id);
    if (m) {
      if (m.sim) return null;
      const { c, h } = runPose(m.run);
      return { pos: add(c, scale(h, m.geo.L / 2)), dir: h, trail: this.bodies.get(id)?.trail };
    }
    const geo = this.parked.get(id);
    if (!geo) return null;
    return { pos: add(geo.ramp.c, scale(geo.ramp.h, geo.L / 2)), dir: geo.ramp.h, trail: this.bodies.get(id)?.trail };
  }

  /** Грузовики во дворах (не в потоке): id. */
  yardIds(): number[] {
    const out: number[] = [];
    for (const m of this.moves.values()) if (!m.sim) out.push(m.id);
    for (const id of this.parked.keys()) out.push(id);
    return out;
  }
}

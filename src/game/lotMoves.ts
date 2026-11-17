import { add, angleDiff, angleOf, dist, scale, sub, type Vec } from '../core/vec';
import { curveSpeed } from '../lanes/speedProfile';
import type { LaneTraffic } from '../lanes/traffic';
import { steerBase } from '../sim/body';
import type { Vehicle, VehicleSpec } from '../sim/vehicle';

/**
 * Манёвры во дворах: отрезки пути середины кузова (кривая Безье или прямая), передом или задним ходом, и как машина
 * по ним едет. Общее для машин жителей у гаражей и стоянок (game/garages.ts), на полосах стоянки
 * (game/curbParking.ts) и грузовиков у рамп получателей (game/docks.ts).
 *
 * Машина идёт по отрезкам подряд (Run, advance): тем же ходом — не тормозя на стыках, но заранее сбрасывая скорость
 * до предела следующего; сменив ход (вперёд ↔ назад) — с места. На дуге — не быстрее √(LATERAL·R), как на поворотах
 * дорог (lanes/speedProfile.curveSpeed). Сворачивая с полосы, машина подъезжает к началу манёвра уже на скорости его
 * первой дуги (entrySpeed, LaneTraffic.slowTo) и проходит её без остановки; встаёт она, только когда есть причина
 * (встречка, место или двор заняты) или перед ходом назад.
 */

/** Отрезок пути манёвра: точки середины кузова, касательные (по ходу), длины до точек, задним ходом ли, предел скорости. */
export interface Leg {
  pts: Vec[];
  tan: Vec[];
  cum: number[];
  len: number;
  back: boolean;
  /** Предел скорости: заданный, а на дуге — не выше скорости поворота по её самому крутому месту. */
  vmax: number;
}

/** На дуге манёвра — не медленнее стольких м/с игры, как бы круто ни было (иначе — ползком). */
const MIN_TURN = 2;
/** Самая малая скорость на ходу, м/с игры: в конце отрезка машина доезжает до него, а не замирает в шаге от него. */
const CREEP = 0.3;

/** Кубическая кривая Безье p0 → p3 (касательные — к p1 и от p2) из n частей. */
export function bezier(p0: Vec, p1: Vec, p2: Vec, p3: Vec, back: boolean, vmax: number, n = 18): Leg {
  const pts: Vec[] = [];
  const tan: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
    const d = {
      x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
      y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
    };
    const l = Math.hypot(d.x, d.y) || 1;
    tan.push({ x: d.x / l, y: d.y / l });
  }
  return finish(pts, tan, back, vmax);
}

/** Прямая a → b. */
export function straight(a: Vec, b: Vec, back: boolean, vmax: number): Leg {
  const l = dist(a, b) || 1;
  const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  return finish([a, b], [t, t], back, vmax);
}

/**
 * Ломаная pts середины кузова (по ходу: от первой точки к последней) со скруглёнными углами радиуса до r (не больше
 * половины соседних отрезков; у первого и последнего угла — до всего крайнего отрезка): проезд по площадке от ворот до
 * места. back — задним ходом по ней же (pts — тоже по ходу: нос смотрит против хода).
 */
export function path(pts: Vec[], r: number, back: boolean, vmax: number): Leg {
  const p = pts.filter((q, i) => i === 0 || dist(q, pts[i - 1]) > 1e-6);
  if (p.length < 2) return straight(p[0] ?? { x: 0, y: 0 }, p[0] ?? { x: 0, y: 0 }, back, vmax);
  const out: Vec[] = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1];
    const c = p[i];
    const b = p[i + 1];
    const lin = dist(a, c);
    const lout = dist(c, b);
    const k = Math.min(r, i === 1 ? lin : lin / 2, i === p.length - 2 ? lout : lout / 2);
    const u = { x: (c.x - a.x) / lin, y: (c.y - a.y) / lin };
    const v = { x: (b.x - c.x) / lout, y: (b.y - c.y) / lout };
    const s = { x: c.x - u.x * k, y: c.y - u.y * k };
    const e = { x: c.x + v.x * k, y: c.y + v.y * k };
    // Угол — квадратичной кривой s → c → e.
    for (let j = 0; j <= 8; j++) {
      const t = j / 8;
      const w = 1 - t;
      out.push({ x: w * w * s.x + 2 * w * t * c.x + t * t * e.x, y: w * w * s.y + 2 * w * t * c.y + t * t * e.y });
    }
  }
  out.push(p[p.length - 1]);
  const q = out.filter((x, i) => i === 0 || dist(x, out[i - 1]) > 1e-6);
  const tan = q.map((_, i) => {
    const a = q[Math.max(0, i - 1)];
    const b = q[Math.min(q.length - 1, i + 1)];
    const l = dist(a, b) || 1;
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  });
  return finish(q, tan, back, vmax);
}

/** Тот же путь в обратную сторону: обратный порядок точек, касательные — по новому ходу. */
export function reversed(leg: Leg, back: boolean, vmax: number): Leg {
  const pts = [...leg.pts].reverse();
  const tan = [...leg.tan].reverse().map((t) => ({ x: -t.x, y: -t.y }));
  return finish(pts, tan, back, vmax);
}

function finish(pts: Vec[], tan: Vec[], back: boolean, vmax: number): Leg {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  // Самое крутое место дуги — по повороту касательной на соседних частях.
  let r = Infinity;
  for (let i = 1; i < pts.length - 1; i++) {
    const turn = Math.abs(angleDiff(angleOf(tan[i - 1]), angleOf(tan[i + 1])));
    if (turn > 1e-4) r = Math.min(r, (cum[i + 1] - cum[i - 1]) / turn);
  }
  const v = r < Infinity ? Math.min(vmax, Math.max(MIN_TURN, curveSpeed(r))) : vmax;
  return { pts, tan, cum, len: cum[cum.length - 1], back, vmax: v };
}

/** Середина кузова и курс (нос) на отрезке в s от его начала: задним ходом нос смотрит против хода. */
export function legPose(leg: Leg, s: number): { c: Vec; h: Vec } {
  const { pts, tan, cum } = leg;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const span = cum[i] - cum[i - 1];
  const t = span > 1e-9 ? Math.max(0, Math.min(1, (s - cum[i - 1]) / span)) : 1;
  const c = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
  const hx = tan[i - 1].x + (tan[i].x - tan[i - 1].x) * t;
  const hy = tan[i - 1].y + (tan[i].y - tan[i - 1].y) * t;
  const l = Math.hypot(hx, hy) || 1;
  const k = leg.back ? -1 / l : 1 / l;
  return { c, h: { x: hx * k, y: hy * k } };
}

/** Машина на манёвре: отрезки по порядку, на каком она, где на нём и скорость. */
export interface Run {
  legs: Leg[];
  i: number;
  s: number;
  v: number;
}

/** Как машина разгоняется и тормозит на манёвре, м/с² игры. */
export interface Drive {
  accel: number;
  brake: number;
}

/** Прогон по отрезкам legs с их начала; v — скорость в начале (свернула с полосы с ходу), иначе — с места. */
export const runOf = (legs: Leg[], v = 0): Run => ({ legs, i: 0, s: 0, v });

/** Где машина на прогоне: середина кузова и курс. */
export const runPose = (r: Run): { c: Vec; h: Vec } => legPose(r.legs[r.i], r.s);

/**
 * Предел скорости в s на отрезке i: не быстрее vmax его и следующих тем же ходом (к ним — тормозя заранее с brake) и
 * так, чтобы встать в конце хода; если ход идёт до конца отрезков — доехать до конца на скорости end (0 — встать).
 */
export function capAt(legs: Leg[], i: number, s: number, brake: number, end = 0): number {
  const back = legs[i].back;
  let cap = legs[i].vmax;
  let d = Math.max(0, legs[i].len - s);
  for (let j = i + 1; ; j++) {
    const next = legs[j];
    if (!next || next.back !== back) {
      const ve = next ? 0 : Math.min(end, cap);
      return Math.min(cap, Math.sqrt(ve * ve + 2 * brake * d));
    }
    cap = Math.min(cap, Math.sqrt(next.vmax * next.vmax + 2 * brake * d));
    d += next.len;
  }
}

/** С какой скоростью машина может начать отрезки legs с ходу: так она подъезжает к началу манёвра (LaneTraffic.slowTo). */
export const entrySpeed = (legs: Leg[], brake: number): number => capAt(legs, 0, 0, brake);

/** Сколько пути до конца хода (стыки тем же ходом — насквозь): дальше — встать или сменить ход. */
export function aheadOf(r: Run): number {
  let d = r.legs[r.i].len - r.s;
  for (let j = r.i + 1; j < r.legs.length && r.legs[j].back === r.legs[r.i].back; j++) d += r.legs[j].len;
  return d;
}

/**
 * Пора ли решать, встать в конце хода или продолжить его с ходу (выезд со двора в просвет): до конца — тормозной путь
 * с нынешней скорости и ещё немного — машина смотрит по сторонам, ещё не тормозя.
 */
export const decideNow = (r: Run, brake: number): boolean => aheadOf(r) <= (r.v * r.v) / (2 * brake) + 1.5;

/**
 * Шаг по отрезкам: разгон accel до предела capAt (end — скорость в конце последнего отрезка), дальше по отрезкам —
 * тем же ходом с той же скоростью, сменив ход — с места. passed(i) — машина ушла с отрезка i на следующий. true —
 * отрезки кончились: машина в конце последнего.
 */
export function advance(r: Run, dt: number, drive: Drive, end = 0, passed?: (i: number) => void): boolean {
  r.v = Math.max(CREEP, Math.min(r.v + drive.accel * dt, capAt(r.legs, r.i, r.s, drive.brake, end)));
  r.s += r.v * dt;
  while (r.s >= r.legs[r.i].len) {
    const was = r.legs[r.i];
    if (r.i === r.legs.length - 1) {
      r.s = was.len;
      return true;
    }
    const over = r.s - was.len;
    r.i++;
    passed?.(r.i - 1);
    const now = r.legs[r.i];
    if (now.back === was.back) r.s = Math.min(over, now.len);
    else {
      r.s = 0;
      r.v = 0;
    }
  }
  return false;
}

/**
 * Машина в потоке на манёвре — там, где она на нём: нос, курс, корма; поток держит её на месте (holdAfter), для него
 * она стоит. blinker — поворотник.
 */
export function poseSim(sim: Vehicle, r: Run, blinker: -1 | 0 | 1): void {
  const { c, h } = runPose(r);
  const nose = add(c, scale(h, sim.length / 2));
  sim.pos = nose;
  sim.dir = h;
  sim.rear = sub(nose, scale(h, steerBase(sim.body) * sim.length));
  sim.v = 0;
  sim.blinker = blinker;
}

/**
 * Встать в поток со двора: машина на полосе laneId носом в u (едет к узлу target, последней связью — endLink); пока
 * она выезжает, поток держит её на месте и она не перестраивается. Места нет (не доехать, занято) — null.
 */
export function joinLane(traffic: LaneTraffic, spec: VehicleSpec, laneId: number, u: number, target: number, endLink?: number): Vehicle | null {
  const sim = traffic.placeOnLane({ ...spec, targetNode: target, endLink }, laneId, u);
  if (!sim) return null;
  traffic.holdAfter(sim, 0);
  // Путь кончается связью у места — сразу, а не когда тронется (иначе, пересчитав путь на манёвре, она поехала бы
  // просто к узлу, а связь у места разошлась бы с концом пути).
  if (endLink !== undefined) sim.endLink = endLink;
  sim.lcCooldown = 1e9;
  return sim;
}

/** Встала на полосу носом по ходу — дальше едет сама: со скоростью v (выехала передом с ходу) или с места. */
export function handOff(traffic: LaneTraffic, sim: Vehicle, v = 0): void {
  traffic.release(sim);
  sim.lcCooldown = 0.5;
  sim.v = v;
}

/** Поездка в потоке кончилась у места: кузов ушёл с полосы во двор — машину с потока снять, поездку засчитать. */
export function leaveFlow(traffic: LaneTraffic, sim: Vehicle): void {
  traffic.remove(sim);
  traffic.arrivals++;
  traffic.totalTripTime += sim.tripTime;
}

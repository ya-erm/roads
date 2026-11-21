import { CurveLUT, minRadius, straightCubic, type Cubic } from '../core/bezier';
import { clamp } from '../core/math';
import { add, cross, dist, dot, norm, rightNormal, scale, sub, type Vec } from '../core/vec';
import { boxesOverlap } from '../lanes/curb';
import { hitchOf, jointOf, steerBase, vehicleBoxes } from '../sim/body';
import type { VehicleSpec } from '../sim/vehicle';
import type { Footprint } from '../world/spatial';
import { LONGEST_BUS, type BayEntry, type Pose } from './transport';

export interface YardPose extends Pose {
  trail?: Pose['pos'];
  done: boolean;
}

type AxlePath = Pick<CurveLUT, 'length' | 'pointAt' | 'tangentAt'>;
type YardExitPath = ((t: number) => YardPose) & { pulloutTime: number; reverseUntil: number; forwardRadius: number; smooth: boolean };
export type YardExitArc = 'compact' | 'wide' | 'aisle' | 'smooth';
export const YARD_ENTRY_SPEED = 1.12;
export const YARD_EXIT_SPEED = 1.4 * YARD_ENTRY_SPEED;
const REVERSE_YAW_RATE = (Math.PI / 4) / YARD_EXIT_SPEED;

function axleCurve(from: Pose, to: Pose, spec: VehicleSpec, intoBay = false, outer = false): CurveLUT {
  const base = spec.length * steerBase(spec.body);
  const a = sub(from.pos, scale(from.dir, base));
  const b = sub(to.pos, scale(to.dir, base));
  const delta = sub(b, a);
  const handle = Math.max(1, dist(a, b) / 3);
  const turning = dot(from.dir, to.dir) < 0.8;
  const reach = (dir: Pose['dir']) => turning ? handle : Math.min(handle, Math.max(1, dot(delta, dir) * 0.44));
  const depth = Math.max(1, dot(delta, to.dir));
  // Сдвиг вбок — до ряда припаркованных машин: в последние метры тягач входит почти прямо.
  const lead = intoBay && !turning ? Math.min(handle, depth * (outer ? 0.10 : 0.2)) : reach(from.dir);
  const finish = intoBay ? Math.max(reach(to.dir), depth * (outer ? 0.98 : 0.78)) : reach(to.dir);
  return new CurveLUT({
    p0: a,
    p1: add(a, scale(from.dir, lead)),
    p2: sub(b, scale(to.dir, finish)),
    p3: b,
  });
}

/** Кривая задней оси. Нос вынесен вперёд по касательной, поэтому кузов поворачивает на ходу. */
function yardLeg(curve: AxlePath, from: Pose, to: Pose, spec: VehicleSpec, t: number, speed: number, v0 = 0, v1 = 0): YardPose {
  const duration = Math.max(0.8, curve.length / speed);
  const u = clamp(t / duration, 0, 1);
  if (u === 1) return { ...to, done: true };
  if (u === 0) return { ...from, done: false };
  const s = curve.length * u * u * (3 - 2 * u) + duration * u * (1 - u) * ((1 - u) * Math.min(v0, speed) - u * Math.min(v1, speed));
  const axle = curve.pointAt(s);
  const dir = curve.tangentAt(s);
  const base = spec.length * steerBase(spec.body);
  const pos = add(axle, scale(dir, base));
  const h = hitchOf(spec.body);
  if (!h) return { pos, dir, done: false };
  const joint = jointOf(pos, dir, spec.length, h);
  const tail = h.tail * spec.length;
  const behind = s < tail ? add(from.pos, scale(from.dir, s - tail - base)) : curve.pointAt(s - tail);
  // Перед остановкой или передачей на дорогу обе части выпрямляются вдоль полосы.
  const straighten = clamp((curve.length - s) / tail, 0, 1);
  const trailerDir = norm(add(scale(dir, 1 - straighten), scale(norm(sub(axle, behind)), straighten)));
  return { pos, dir, trail: sub(joint, scale(trailerDir, tail)), done: false };
}

export function yardEntryMotion(entry: BayEntry, to: Pose, spec: VehicleSpec): (t: number) => YardPose {
  const gate = entry.gate ?? entry;
  const fromRoad = dist(entry.pos, gate.pos) > 0.2 ? axleCurve(entry, gate, spec) : null;
  const gateTime = fromRoad ? Math.max(0.8, fromRoad.length / 8) : 0;
  const lateral = Math.abs(dot(sub(to.pos, gate.pos), rightNormal(to.dir)));
  const fromSide = Math.abs(dot(gate.dir, to.dir)) < 0.55;
  const straight = fromSide ? Math.max(0, dot(sub(to.pos, gate.pos), gate.dir) - 16) : 0;
  const turn = { pos: add(gate.pos, scale(gate.dir, straight)), dir: gate.dir };
  const approach = straight > 0 ? axleCurve(gate, turn, spec) : null;
  const turnStart = approach ? Math.max(0.8, approach.length / 8) : 0;
  const finish = axleCurve(turn, to, spec, true, entry.outer);
  const speed = fromSide ? 8 : Math.max(5.5, 8 - lateral * 0.1);
  return (t) => {
    if (fromRoad && t < gateTime) return { ...yardLeg(fromRoad, entry, gate, spec, t, 8, entry.v0, 8), done: false };
    const intoYard = t - gateTime;
    const speedAtGate = fromRoad ? 8 : entry.v0;
    if (approach && intoYard < turnStart) return { ...yardLeg(approach, gate, turn, spec, intoYard, 8, speedAtGate, 8), done: false };
    return yardLeg(finish, turn, to, spec, intoYard - turnStart, speed, approach ? 8 : speedAtGate);
  };
}

/** Прямые по проезду и полосе с одной касательной дугой между ними. */
function roundedExit(axle: Vec, dir: Vec, road: Pose, base: number, length: number): { path: AxlePath; radius: number } | null {
  const turn = cross(dir, road.dir);
  if (Math.abs(turn) < 0.25) return null;
  const finish = sub(road.pos, scale(road.dir, base));
  const delta = sub(finish, axle);
  const toCorner = cross(delta, road.dir) / turn;
  const fromCorner = cross(dir, delta) / turn;
  const angle = Math.acos(clamp(dot(dir, road.dir), -1, 1));
  const tangent = Math.tan(angle / 2);
  const radius = Math.min(toCorner / tangent, fromCorner / tangent, Math.max(6, length * 0.65));
  if (radius < Math.max(3.5, base * 0.85)) return null;
  const cut = radius * tangent;
  const start = add(axle, scale(dir, toCorner - cut));
  const end = sub(finish, scale(road.dir, fromCorner - cut));
  const handle = (4 / 3) * Math.tan(angle / 4) * radius;
  const arc: Cubic = { p0: start, p1: add(start, scale(dir, handle)), p2: sub(end, scale(road.dir, handle)), p3: end };
  const segments = [straightCubic(axle, start), arc, straightCubic(end, finish)]
    .filter((c) => dist(c.p0, c.p3) > 1e-6)
    .map((c) => new CurveLUT(c));
  const endIndex = segments.length - 1;
  const at = (s: number) => {
    let i = 0;
    while (i < endIndex && s > segments[i].length) s -= segments[i++].length;
    return { segment: segments[i], s };
  };
  const path: AxlePath = {
    length: segments.reduce((sum, segment) => sum + segment.length, 0),
    pointAt(s) { const { segment, s: local } = at(s); return segment.pointAt(local); },
    tangentAt(s) { const { segment, s: local } = at(s); return segment.tangentAt(local); },
  };
  return { path, radius };
}

/** Плотные повороты проходим медленнее: время участка учитывает и ход оси, и поворот тягача. */
function reversePace(curve: CurveLUT, nominal: number, compact: boolean): { duration: number; nominalAt: (t: number) => number } {
  const steps = compact ? 384 : 192;
  const regular = [0];
  const paced = [0];
  let before = curve.tangentAt(0);
  for (let i = 1; i <= steps; i++) {
    const s = curve.sAtT(i / steps);
    const dir = curve.tangentAt(s);
    // Обратная функция от u²(3 − 2u), которая задаёт разгон и торможение в yardLeg.
    const time = i === steps ? nominal : nominal * (0.5 - Math.sin(Math.asin(1 - 2 * s / curve.length) / 3));
    const travelTime = time - regular[i - 1];
    const turnTime = Math.abs(Math.atan2(cross(before, dir), dot(before, dir))) / REVERSE_YAW_RATE;
    regular.push(time);
    paced.push(paced[i - 1] + Math.max(travelTime, turnTime));
    before = dir;
  }
  const duration = paced[steps];
  if (duration <= nominal + 1e-6) return { duration: nominal, nominalAt: (t) => t };
  return {
    duration,
    nominalAt(t) {
      let lo = 0;
      let hi = steps;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (paced[mid] < t) lo = mid;
        else hi = mid;
      }
      const f = clamp((t - paced[lo]) / (paced[hi] - paced[lo]), 0, 1);
      return regular[lo] + (regular[hi] - regular[lo]) * f;
    },
  };
}

/** Задним ходом в маневровый проезд, остановка и поворот вперёд к выезду. */
function planExit(parked: Pose, road: Pose, spec: VehicleSpec, yard: Footprint, arc: YardExitArc | undefined, pullout: boolean, smoothReverse: boolean): YardExitPath {
  const outer = arc === 'wide';
  const aisle = arc === 'aisle';
  const compact = arc === 'compact';
  const out = scale(parked.dir, -1);
  const across = rightNormal(out);
  const delta = sub(road.pos, parked.pos);
  const lateral = dot(delta, across);
  const side = scale(across, Math.sign(lateral) || 1);
  const base = spec.length * steerBase(spec.body);
  const depth = dot(delta, out);
  const gateAcross = dot(sub(road.pos, yard.center), across);
  const viaSide = Math.abs(dot(road.dir, out)) < 0.55 && Math.abs(gateAcross) > yard.w / 2 - 10;
  const sideRoom = yard.w / 2 + dot(sub(parked.pos, yard.center), side);
  const turnRoom = viaSide ? Math.min(18, 4 + Math.max(base, spec.length * 0.45)) : Math.max(2.5, (outer ? 18 : 14) - Math.abs(lateral));
  // Запас для касательной дуги зависит от смещения до выезда. Далеко от него можно разворачиваться почти на месте.
  const swingRoom = compact ? Math.max(0, Math.max(5.5, base + 0.8) - Math.abs(lateral)) : turnRoom;
  const swing = Math.min(swingRoom, sideRoom - (spec.length - base) - spec.width / 2 - 1);
  // Длинному прицепу оставляем место для дуги выезда, короткие машины начинают рулить позже, чтобы не задеть ряд.
  const longTrailer = spec.body === 'longSemi';
  const forwardRoom = (longTrailer ? base + 12 : Math.min(base + 12, spec.length / 2 + 4)) + (outer ? 3 : 0);
  const behindRow = Math.min(yard.h / 2 - 0.5, LONGEST_BUS - 1) + spec.width / 2 + 1.5;
  const aisleDepth = behindRow - dot(sub(parked.pos, yard.center), out);
  const wanted = depth - (viaSide ? 0 : forwardRoom);
  const clearRow = !viaSide && wanted < aisleDepth;
  const aisleLimit = yard.h / 2 + 9 - dot(sub(parked.pos, yard.center), out);
  const turnDepth = Math.max(base + 6, wanted, clearRow ? aisleDepth : 0, aisle && !viaSide ? Math.min(aisleLimit, Math.max(aisleDepth, wanted) + 7) : 0);
  const startAxle = (turnAt: number) => add(parked.pos, add(scale(out, turnAt), scale(side, -swing)));
  const aligned = startAxle(Math.max(base + 6, aisleDepth + spec.width / 2));
  const rounded = (compact || arc === 'smooth') && !viaSide && dot(road.dir, out) > 0.8 ? roundedExit(aligned, side, road, base, spec.length) : null;
  const dir = rounded || viaSide || clearRow || aisle ? side : norm(add(side, scale(parked.dir, 0.16)));
  const axle = rounded ? aligned : startAxle(turnDepth);
  const turn = { pos: add(axle, scale(dir, base)), dir };
  const backed = pullout ? { ...parked, pos: add(parked.pos, scale(out, 2)) } : parked;
  const straight = pullout ? axleCurve(backed, parked, spec) : null;
  const reverse = axleCurve(turn, backed, spec, !!arc || viaSide || clearRow || !longTrailer, aisle || !!rounded);
  const pace = clamp(yard.h / 52, 0.62, 1);
  const reverseSpeed = 2.5 * pace;
  const pulloutTime = straight ? Math.max(0.8, straight.length / reverseSpeed) : 0;
  const seconds = Math.max(0.8, reverse.length / reverseSpeed);
  const timing = smoothReverse ? reversePace(reverse, seconds, compact) : { duration: seconds, nominalAt: (t: number) => t };
  const cubicForward = rounded ? null : axleCurve(turn, road, spec);
  const forward = rounded?.path ?? cubicForward!;
  const forwardRadius = rounded?.radius ?? minRadius(cubicForward!.curve);
  const forwardSpeed = 3.7 * pace * clamp(forwardRadius / Math.max(4, base * 0.65), 0.65, 1);
  // При передаче на дорогу симулятор начинает с 3 ед./с.
  const handoffSpeed = rounded ? 3 / YARD_EXIT_SPEED : 3;
  // Путь задним ходом — та же кривая осей, проигранная от поста к проезду.
  const pose = (t: number) => {
    if (straight && t < pulloutTime) return { ...yardLeg(straight, backed, parked, spec, pulloutTime - t, reverseSpeed), done: false };
    const after = t - pulloutTime;
    return after < timing.duration
      ? { ...yardLeg(reverse, turn, backed, spec, timing.nominalAt(timing.duration - after), reverseSpeed), done: false }
      : yardLeg(forward, turn, road, spec, after - timing.duration, forwardSpeed, 0, handoffSpeed);
  };
  return Object.assign(pose, { pulloutTime, reverseUntil: pulloutTime + timing.duration, forwardRadius, smooth: !!rounded });
}

const exitPlans = new WeakMap<Footprint, Map<string, YardExitPath>>();

export function yardExitMotion(parked: Pose, road: Pose, spec: VehicleSpec, yard: Footprint, arc?: YardExitArc, pullout = false, smoothReverse = true): YardExitPath {
  let plans = exitPlans.get(yard);
  if (!plans) exitPlans.set(yard, (plans = new Map()));
  const key = [parked.pos.x, parked.pos.y, parked.dir.x, parked.dir.y, road.pos.x, road.pos.y, road.dir.x, road.dir.y, spec.body, spec.length, spec.width, arc, pullout, smoothReverse].join('|');
  const cached = plans.get(key);
  if (cached) return cached;
  if (plans.size >= 192) plans.clear();
  const motion = planExit(parked, road, spec, yard, arc, pullout, smoothReverse);
  plans.set(key, motion);
  return motion;
}

/** У близкого выезда поворот выгодно начать раньше, если более широкая дуга помещается во дворе. */
export function yardExitArcs(parked: Pose, road: Pose, spec: VehicleSpec, yard: Footprint, pullout = false) {
  const compact = yardExitMotion(parked, road, spec, yard, 'compact', pullout);
  const smooth = yardExitMotion(parked, road, spec, yard, 'smooth', pullout);
  const normal = yardExitMotion(parked, road, spec, yard, undefined, pullout);
  const wide = yardExitMotion(parked, road, spec, yard, 'wide', pullout);
  const preferWide = normal.forwardRadius < spec.length * 0.45 && wide.forwardRadius > normal.forwardRadius + 0.5;
  const first = { path: normal, arc: undefined };
  const second = { path: wide, arc: 'wide' as const };
  return [
    ...(compact.smooth ? [{ path: compact, arc: 'compact' as const }] : []),
    ...(smooth.smooth ? [{ path: smooth, arc: 'smooth' as const }] : []),
    ...(preferWide ? [second, first] : [first, second]),
    { path: yardExitMotion(parked, road, spec, yard, 'aisle', pullout), arc: 'aisle' as const },
  ];
}

export interface YardMotion {
  pose(t: number): YardPose;
  spec: VehicleSpec;
  /** Машина остаётся на посту или у выезда до передачи потоку. */
  parks: boolean;
}

function yardPosesOverlap(a: YardPose, sa: VehicleSpec, b: YardPose, sb: VehicleSpec): boolean {
  if (dist(a.pos, b.pos) > sa.length + sb.length + 2) return false;
  const boxes = vehicleBoxes(b.pos, b.dir, sb.length, sb.width + 0.8, sb.body, b.trail);
  return vehicleBoxes(a.pos, a.dir, sa.length, sa.width + 0.8, sa.body, a.trail).some((part) => boxes.some((box) => boxesOverlap(part, box)));
}

/** Прогноз габаритов тягачей и прицепов. Проверяем оставшуюся часть обоих манёвров. */
export function yardPathsConflict(a: YardMotion, b: YardMotion): boolean {
  for (let t = 0; t < 120; t += 0.075) {
    const x = a.pose(t);
    const y = b.pose(t);
    if ((x.done && !a.parks) || (y.done && !b.parks)) return false;
    if (yardPosesOverlap(x, a.spec, y, b.spec)) return true;
    if (x.done && y.done) return false;
  }
  return true;
}

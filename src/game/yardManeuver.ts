import { CurveLUT, minRadius } from '../core/bezier';
import { clamp } from '../core/math';
import { add, dist, dot, norm, rightNormal, scale, sub } from '../core/vec';
import { boxesOverlap } from '../lanes/curb';
import { hitchOf, jointOf, steerBase, vehicleBoxes } from '../sim/body';
import type { VehicleSpec } from '../sim/vehicle';
import type { Footprint } from '../world/spatial';
import type { BayEntry, Pose } from './transport';

export interface YardPose extends Pose {
  trail?: Pose['pos'];
  done: boolean;
}

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
function yardLeg(curve: CurveLUT, from: Pose, to: Pose, spec: VehicleSpec, t: number, speed: number, v0 = 0, v1 = 0): YardPose {
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
  const behind = s < tail ? add(curve.curve.p0, scale(from.dir, s - tail)) : curve.pointAt(s - tail);
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

/** Задним ходом в маневровый проезд, остановка и поворот вперёд к выезду. */
function planExit(parked: Pose, road: Pose, spec: VehicleSpec, yard: Footprint): (t: number) => YardPose {
  const out = scale(parked.dir, -1);
  const across = rightNormal(out);
  const delta = sub(road.pos, parked.pos);
  const lateral = dot(delta, across);
  const side = scale(across, Math.sign(lateral) || 1);
  const base = spec.length * steerBase(spec.body);
  const depth = dot(delta, out);
  const viaSide = Math.abs(dot(road.dir, out)) < 0.55 && Math.abs(lateral) > yard.w / 2 - 10;
  const dir = viaSide ? side : norm(add(side, scale(parked.dir, 0.16)));
  const sideRoom = yard.w / 2 + dot(sub(parked.pos, yard.center), side);
  const swing = Math.min(Math.max(2.5, 14 - Math.abs(lateral)), sideRoom - (spec.length - base) - spec.width / 2 - 1);
  // Длинному прицепу оставляем место для дуги выезда, короткие машины начинают рулить позже, чтобы не задеть ряд.
  const longTrailer = spec.body === 'longSemi';
  const forwardRoom = longTrailer ? base + 12 : Math.min(base + 12, spec.length / 2 + 4);
  const turnDepth = Math.max(base + 6, depth - (viaSide ? 3 : forwardRoom));
  const axle = add(parked.pos, add(scale(out, turnDepth), scale(side, -swing)));
  const turn = { pos: add(axle, scale(dir, base)), dir };
  const reverse = axleCurve(turn, parked, spec, viaSide || !longTrailer);
  const pace = clamp(yard.h / 52, 0.62, 1);
  const reverseSpeed = 2.5 * pace;
  const seconds = Math.max(0.8, reverse.length / reverseSpeed);
  const forward = axleCurve(turn, road, spec);
  const forwardSpeed = 3.7 * pace * clamp(minRadius(forward.curve) / Math.max(4, base * 0.65), 0.65, 1);
  // Путь задним ходом — та же кривая осей, проигранная от поста к проезду.
  return (t) => t < seconds
    ? { ...yardLeg(reverse, turn, parked, spec, seconds - t, reverseSpeed), done: false }
    : yardLeg(forward, turn, road, spec, t - seconds, forwardSpeed, 0, 3);
}

const exitPlans = new WeakMap<Footprint, Map<string, (t: number) => YardPose>>();

export function yardExitMotion(parked: Pose, road: Pose, spec: VehicleSpec, yard: Footprint): (t: number) => YardPose {
  let plans = exitPlans.get(yard);
  if (!plans) exitPlans.set(yard, (plans = new Map()));
  const key = [parked.pos.x, parked.pos.y, parked.dir.x, parked.dir.y, road.pos.x, road.pos.y, road.dir.x, road.dir.y, spec.body, spec.length, spec.width].join('|');
  const cached = plans.get(key);
  if (cached) return cached;
  if (plans.size >= 64) plans.clear();
  const motion = planExit(parked, road, spec, yard);
  plans.set(key, motion);
  return motion;
}

export interface YardMotion {
  pose(t: number): YardPose;
  spec: VehicleSpec;
  /** Машина остаётся на посту или у выезда до передачи потоку. */
  parks: boolean;
}

/** Прогноз габаритов тягачей и прицепов. Проверяем оставшуюся часть обоих манёвров. */
export function yardPathsConflict(a: YardMotion, b: YardMotion): boolean {
  const body = (p: YardPose, s: VehicleSpec) => vehicleBoxes(p.pos, p.dir, s.length, s.width + 0.8, s.body, p.trail);
  for (let t = 0; t < 120; t += 0.15) {
    const x = a.pose(t);
    const y = b.pose(t);
    if (dist(x.pos, y.pos) <= a.spec.length + b.spec.length + 2) {
      const other = body(y, b.spec);
      if (body(x, a.spec).some((part) => other.some((box) => boxesOverlap(part, box)))) return true;
    }
    if ((x.done && !a.parks) || (y.done && !b.parks) || (x.done && y.done)) return false;
  }
  return true;
}

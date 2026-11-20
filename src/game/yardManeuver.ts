import { CurveLUT } from '../core/bezier';
import { clamp } from '../core/math';
import { add, dist, dot, norm, rightNormal, scale, sub } from '../core/vec';
import { hitchOf, jointOf, steerBase } from '../sim/body';
import type { VehicleSpec } from '../sim/vehicle';
import type { Footprint } from '../world/spatial';
import type { BayEntry, Pose } from './transport';

export interface YardPose extends Pose {
  trail?: Pose['pos'];
  done: boolean;
}

function axleCurve(from: Pose, to: Pose, spec: VehicleSpec): CurveLUT {
  const base = spec.length * steerBase(spec.body);
  const a = sub(from.pos, scale(from.dir, base));
  const b = sub(to.pos, scale(to.dir, base));
  const delta = sub(b, a);
  const handle = Math.max(1, dist(a, b) / 3);
  const turning = dot(from.dir, to.dir) < 0.8;
  const reach = (dir: Pose['dir']) => turning ? handle : Math.min(handle, Math.max(1, dot(delta, dir) * 0.44));
  return new CurveLUT({
    p0: a,
    p1: add(a, scale(from.dir, reach(from.dir))),
    p2: sub(b, scale(to.dir, reach(to.dir))),
    p3: b,
  });
}

/** Кривая задней оси. Нос вынесен вперёд по касательной, поэтому кузов поворачивает на ходу. */
function yardLeg(curve: CurveLUT, from: Pose, to: Pose, spec: VehicleSpec, t: number, speed: number, v0 = 0, v1 = 0): YardPose {
  const duration = Math.max(0.8, curve.length / speed);
  const u = clamp(t / duration, 0, 1);
  if (u === 1) return { ...to, done: true };
  if (u === 0) return { ...from, done: false };
  const s = curve.length * u * u * (3 - 2 * u) + duration * u * (1 - u) * ((1 - u) * Math.min(v0, speed) - u * v1);
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

export function yardEntryPose(entry: BayEntry, to: Pose, spec: VehicleSpec): YardPose {
  const lateral = Math.abs(dot(sub(to.pos, entry.pos), rightNormal(to.dir)));
  const speed = Math.max(5.5, 8 - lateral * 0.1);
  return yardLeg(axleCurve(entry, to, spec), entry, to, spec, entry.t, speed, entry.v0);
}

/** Задним ходом в маневровый проезд, остановка и поворот вперёд к выезду. */
export function yardExitPose(parked: Pose, road: Pose, spec: VehicleSpec, yard: Footprint, t: number): YardPose {
  const out = scale(parked.dir, -1);
  const across = rightNormal(out);
  const delta = sub(road.pos, parked.pos);
  const lateral = dot(delta, across);
  const side = scale(across, Math.sign(lateral) || 1);
  const base = spec.length * steerBase(spec.body);
  const depth = dot(delta, out);
  const dir = norm(add(side, scale(parked.dir, 0.16)));
  const sideRoom = yard.w / 2 + dot(sub(parked.pos, yard.center), side);
  const swing = Math.min(Math.max(2.5, 14 - Math.abs(lateral)), sideRoom - (spec.length - base) - spec.width / 2 - 1);
  const axle = add(parked.pos, add(scale(out, Math.max(base + 6, depth - base - 12)), scale(side, -swing)));
  const turn = { pos: add(axle, scale(dir, base)), dir };
  // Для заднего хода проигрываем путь к посту в обратном порядке. Тягач и прицеп остаются сцеплены.
  const reverse = axleCurve(turn, parked, spec);
  const pace = clamp(yard.h / 52, 0.62, 1);
  const reverseSpeed = 2.5 * pace;
  const seconds = Math.max(0.8, reverse.length / reverseSpeed);
  if (t < seconds) {
    const back = yardLeg(reverse, turn, parked, spec, seconds - t, reverseSpeed);
    return { ...back, done: false };
  }
  return yardLeg(axleCurve(turn, road, spec), turn, road, spec, t - seconds, 3.7 * pace, 0, 3);
}

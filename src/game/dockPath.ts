import { add, angleDiff, angleOf, dist, dot, scale, sub, type Vec } from '../core/vec';
import type { Box } from '../lanes/curb';
import { hitchOf, type VehicleBody } from '../sim/body';
import type { Leg } from './lotMoves';

interface Pose { c: Vec; h: Vec; th: Vec }
const unit = (v: Vec): Vec => scale(v, 1 / (Math.hypot(v.x, v.y) || 1));

/** Путь задней оси прицепа задаёт седло, а скорость седла — курс тягача. Оба кузова катятся по своим осям. */
export function planDockPath(start: { c: Vec; h: Vec }, end: { c: Vec; h: Vec }, length: number, width: number, body: VehicleBody, clear: (box: Box) => boolean): Pose[] | null {
  const hitch = hitchOf(body);
  if (!hitch) return null;
  const jointLength = length * hitch.joint, tail = length * hitch.tail;
  const offset = length / 2 - jointLength - tail;
  const a = add(start.c, scale(start.h, offset)), b = add(end.c, scale(end.h, offset));
  const d = dist(a, b);
  const bezier = (points: Vec[], t: number): Vec => {
    let work = points;
    while (work.length > 1) work = work.slice(1).map((p, i) => add(scale(work[i], 1 - t), scale(p, t)));
    return work[0];
  };
  for (const k0 of [0.24, 0.16, 0.32, 0.4]) for (const k1 of [0.24, 0.16, 0.32, 0.4]) {
    const p = [a, add(a, scale(start.h, d * k0)), add(a, scale(start.h, d * k0 * 2)), sub(b, scale(end.h, d * k1 * 2)), sub(b, scale(end.h, d * k1)), b];
    const velocity = p.slice(1).map((v, i) => scale(sub(v, p[i]), 5));
    const acceleration = velocity.slice(1).map((v, i) => scale(sub(v, velocity[i]), 4));
    const poses: Pose[] = [];
    let valid = true;
    const n = Math.max(120, Math.ceil(d * 6));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const rear = bezier(p, t), v = bezier(velocity, t), acc = bezier(acceleration, t);
      const speed = Math.hypot(v.x, v.y);
      if (speed < 0.01) { valid = false; break; }
      const th = scale(v, 1 / speed);
      const turn = scale(sub(acc, scale(th, dot(acc, th))), 1 / speed);
      const h = unit(add(v, scale(turn, tail)));
      if (dot(h, th) < 0.5) { valid = false; break; }
      const joint = add(rear, scale(th, tail));
      const nose = add(joint, scale(h, jointLength));
      const c = sub(nose, scale(h, length / 2));
      const back = -(1 - hitch.joint) * length, front = (hitch.joint - hitch.back) * length;
      const trailer = { c: add(joint, scale(th, (front + back) / 2)), d: th, hl: (front - back) / 2 + 0.05, hw: width / 2 + 0.05 };
      const cab = { c: sub(nose, scale(h, (hitch.front * length) / 2)), d: h, hl: hitch.front * length / 2 + 0.05, hw: width / 2 + 0.05 };
      if (!clear(trailer) || !clear(cab)) { valid = false; break; }
      const prev = poses.at(-1);
      if (prev && Math.abs(angleDiff(angleOf(prev.h), angleOf(h))) > dist(prev.c, c) / 4) { valid = false; break; }
      poses.push({ c, h, th });
    }
    if (valid) return poses;
  }
  return null;
}

export function dockPathLeg(poses: Pose[], vmax: number): Leg {
  const pts = poses.map((p) => p.c);
  const tan = pts.map((_, i) => unit(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)])));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, tan, heading: poses.map((p) => p.h), trailerHeading: poses.map((p) => p.th), cum, len: cum.at(-1)!, back: false, vmax };
}

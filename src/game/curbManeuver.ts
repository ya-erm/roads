import { add, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import { boxesOverlap, CURB, type Box, type CurbStall } from '../lanes/curb';
import { LANE_W } from '../world/roadTypes';
import { bezier, reversed, type Leg } from './lotMoves';
import { clearYardLeg, planYardExit } from './yardExit';

const plans = new Map<string, Leg[] | null>();

/** Вся машина остаётся на парковочной полосе и ближайшей полосе движения, не задевая соседей. */
export function planCurbExit(st: CurbStall, end: { pos: Vec; dir: Vec }, occupied: readonly CurbStall[], length: number, width: number): Leg[] | null {
  const key = `${st.key}:${st.pos.x}:${st.pos.y}:${end.pos.x}:${end.pos.y}:${end.dir.x}:${end.dir.y}:${occupied.map((s) => `${s.key}:${s.pos.x}:${s.pos.y}:${s.dir.x}:${s.dir.y}`).join(',')}:${length}:${width}`;
  if (plans.has(key)) return plans.get(key)!;
  const normal = rightNormal(st.dir);
  const lateral = dot(sub(end.pos, st.pos), normal);
  const along = dot(sub(end.pos, st.pos), st.dir);
  const obstacles: Box[] = occupied.map((s) => ({ c: s.pos, d: s.dir, hl: length / 2 + 0.06, hw: width / 2 + 0.06 }));
  const clear = (box: Box) => {
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      const p = sub(add(add(box.c, scale(box.d, a * box.hl)), scale(rightNormal(box.d), b * box.hw)), st.pos);
      const x = dot(p, st.dir), y = dot(p, normal);
      if (x < -CURB.stallLen * 1.5 || x > along + length || y > CURB.stallDepth / 2 + 0.16 || y < lateral - LANE_W / 2 + 0.1) return false;
    }
    return obstacles.every((o) => !boxesOverlap(box, o));
  };
  const d = Math.hypot(end.pos.x - st.pos.x, end.pos.y - st.pos.y);
  const forward = bezier(st.pos, add(st.pos, scale(st.dir, d * 0.42)), sub(end.pos, scale(end.dir, d * 0.42)), end.pos, false, 6);
  const ahead = occupied.some((s) => dot(sub(s.pos, st.pos), st.dir) > 0 && dot(sub(s.pos, st.pos), st.dir) < length + CURB.stallLen);
  const plan = !ahead && clearYardLeg(forward, length, width, clear) ? [forward] : planYardExit({ c: st.pos, h: st.dir }, { c: end.pos, h: end.dir }, length, width, clear, { step: 0.75, rearOffset: length * 0.28, startBack: true, firstSteer: 1 });
  if (plans.size > 128) plans.clear();
  plans.set(key, plan);
  return plan;
}

/** Заезд в тесный промежуток — обратная траектория безопасного выезда, сначала задним ходом. */
export function planCurbEntry(st: CurbStall, start: { pos: Vec; dir: Vec }, occupied: readonly CurbStall[], length: number, width: number): Leg[] | null {
  return planCurbExit(st, start, occupied, length, width)?.slice().reverse().map((leg) => reversed(leg, !leg.back, leg.back ? 4 : 2.2)) ?? null;
}

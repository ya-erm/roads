import { describe, expect, it } from 'vitest';
import { add, dot, rightNormal, scale } from '../core/vec';
import { boxesOverlap, type CurbStall } from '../lanes/curb';
import { CAR_SIZE } from '../world/houseAccess';
import { planCurbEntry, planCurbExit } from './curbManeuver';
import { legPose } from './lotMoves';

const stall = (idx: number, angle: number): CurbStall => ({ key: `test:${angle}:${idx}`, corridor: 1, lane: 1, side: 1, idx, s: idx * 9.5, pos: { x: idx * 9.5 * Math.cos(angle), y: idx * 9.5 * Math.sin(angle) }, dir: { x: Math.cos(angle), y: Math.sin(angle) } });

describe('Параллельная парковка между соседними машинами', () => {
  it('сначала сдаёт назад с рулём вправо и выезжает без пересечения кузовов; заезжает задним ходом', () => {
    for (const angle of [0, 0.6, Math.PI]) {
      const st = stall(0, angle);
      const neighbors = [stall(-1, angle), stall(1, angle)];
      const end = { pos: add(add(st.pos, scale(st.dir, 12)), scale(rightNormal(st.dir), -6.3)), dir: st.dir };
      const exit = planCurbExit(st, end, neighbors, CAR_SIZE.l, CAR_SIZE.w);
      expect(exit, `angle=${angle}`).not.toBeNull();
      expect(exit![0].back).toBe(true);
      expect(dot(legPose(exit![0], Math.min(0.5, exit![0].len)).h, rightNormal(st.dir))).toBeLessThan(0);
      expect(exit!.at(-1)!.back).toBe(false);
      const entry = planCurbEntry(st, end, neighbors, CAR_SIZE.l, CAR_SIZE.w)!;
      expect(entry[0].back).toBe(true);
      for (const leg of [...exit!, ...entry]) for (let s = 0; s <= leg.len; s += 0.1) {
        const { c, h } = legPose(leg, s);
        const body = { c, d: h, hl: CAR_SIZE.l / 2, hw: CAR_SIZE.w / 2 };
        for (const other of neighbors) expect(boxesOverlap(body, { c: other.pos, d: other.dir, hl: CAR_SIZE.l / 2, hw: CAR_SIZE.w / 2 })).toBe(false);
        for (const a of [-1, 1]) for (const b of [-1, 1]) {
          const corner = add(add(c, scale(h, a * CAR_SIZE.l / 2)), scale(rightNormal(h), b * CAR_SIZE.w / 2));
          expect(dot(corner, rightNormal(st.dir))).toBeLessThan(2.4);
        }
      }
    }
  }, 30_000);
});

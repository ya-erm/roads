import { describe, expect, it } from 'vitest';
import { dot, dist } from '../core/vec';
import type { ParkingLot } from '../world/entities';
import { CAR_SIZE } from '../world/houseAccess';
import { defaultGates, lotDepth, lotGateDriveway, lotLayout, lotWidth, type LotRows } from '../world/parkingLots';
import { planLotExit } from './lotExit';
import { legPose } from './lotMoves';

function lotAt(rows: LotRows, angle = 0): ParkingLot {
  const w = lotWidth(5);
  return { id: 1, fp: { center: { x: 100, y: 100 }, w, h: lotDepth(rows), angle }, gates: defaultGates(w), owner: 'player', tariff: 0 };
}

describe('Выезд с площадки передом', () => {
  it.each([1, 2] as const)('пустая площадка в %i ряд: разворот внутри и выезд передом без скачков', (rows) => {
    for (const angle of [0, 0.4, Math.PI]) {
      const lot = lotAt(rows, angle);
      const gate = lot.gates[0];
      const drive = lotGateDriveway(lot, gate);
      const side = { x: drive.curb.x + drive.dir.x * (CAR_SIZE.l / 2 + 0.3), y: drive.curb.y + drive.dir.y * (CAR_SIZE.l / 2 + 0.3) };
      let found = 0;
      for (const [k, stall] of lotLayout(lot).stalls.entries()) {
        const plan = planLotExit(lot, gate.x, k, side, () => false, CAR_SIZE.l, CAR_SIZE.w);
        if (!plan) continue;
        found++;
        const legs = plan!.legs;
        expect(legs[0].back).toBe(true);
        expect(legs.at(-1)!.back).toBe(false);
        expect(dot(legPose(legs[0], 0).h, stall.dir)).toBeGreaterThan(0.99);
        for (let j = 1; j < legs.length; j++) {
          const a = legPose(legs[j - 1], legs[j - 1].len);
          const b = legPose(legs[j], 0);
          expect(dist(a.c, b.c)).toBeLessThan(0.01);
          expect(dot(a.h, b.h)).toBeGreaterThan(0.995);
        }
        const end = legPose(legs.at(-1)!, legs.at(-1)!.len);
        expect(dist(end.c, side)).toBeLessThan(0.01);
        expect(dot(end.h, drive.dir)).toBeLessThan(-0.995);
      }
      expect(found, `ряд ${rows}, угол ${angle}`).toBeGreaterThanOrEqual(rows === 1 ? 2 : 5);
    }
  });
});
